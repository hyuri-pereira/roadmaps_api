import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { CryptoService } from '../../common/crypto/crypto.service';
import { e164ParaChatId, paraE164 } from '../../common/utils';
import { WahaClient } from '../../integrations/waha/waha.client';
import { UsuariosService } from '../usuarios/usuarios.service';
import { SessaoWaha, ServidorWaha, WahaRepository } from './waha.repository';

const PROPOSITO_API_KEY = 'waha:api_key';
const PROPOSITO_WEBHOOK = 'waha:webhook_secret';

export interface StatusSessaoDto {
  situacao: string;
  numeroConectado: string | null;
  numeroCadastrado: string | null;
  numerosConferem: boolean;
  verificado: boolean;
  conectadoEm: Date | null;
  ultimoErro: string | null;
  proximoPasso: string;
}

/**
 * Sessao de WhatsApp individual por gestor.
 *
 * Regras que este service garante:
 *  - cada gestor tem a propria sessao; nunca usamos a sessao de outro;
 *  - o QR e buscado em tempo real e jamais persistido ou logado;
 *  - o numero conectado precisa ser igual ao cadastrado pelo gestor, senao
 *    a verificacao nao e concedida e nenhum aviso e enviado;
 *  - logout invalida a verificacao.
 */
@Injectable()
export class WahaService implements OnModuleInit {
  private readonly logger = new Logger(WahaService.name);

  constructor(
    private readonly repo: WahaRepository,
    private readonly crypto: CryptoService,
    private readonly usuarios: UsuariosService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.semearServidor();
  }

  /** Cadastra o servidor WAHA do .env no primeiro boot. */
  private async semearServidor(): Promise<void> {
    if (!this.config.waha.habilitado) return;
    if (!this.config.waha.apiKey || !this.config.waha.baseUrl) {
      this.logger.warn('WAHA_ENABLED=true mas WAHA_BASE_URL/WAHA_API_KEY estao vazios.');
      return;
    }

    const envelopeChave = this.crypto.cifrar(this.config.waha.apiKey, PROPOSITO_API_KEY);
    const envelopeSegredo = this.config.waha.webhookSecret
      ? this.crypto.cifrar(this.config.waha.webhookSecret, PROPOSITO_WEBHOOK)
      : null;

    await this.repo.salvarServidor({
      nome: this.config.waha.nome,
      baseUrl: this.config.waha.baseUrl,
      apiKeyCifrada: envelopeChave.conteudo,
      apiKeyNonce: envelopeChave.nonceBase64,
      webhookSecretCifrado: envelopeSegredo?.conteudo ?? null,
      webhookNonce: envelopeSegredo?.nonceBase64 ?? null,
      versaoChave: envelopeChave.versaoChave,
    });
    this.logger.log(`Servidor WAHA "${this.config.waha.nome}" cadastrado.`);
  }

  criarCliente(servidor: ServidorWaha): WahaClient {
    const apiKey = this.crypto.decifrar(
      servidor.apiKeyCifrada,
      PROPOSITO_API_KEY,
      servidor.versaoChave,
    );
    return new WahaClient(servidor.baseUrl, apiKey, this.config.waha.timeoutMs);
  }

  // ------------------------------------------------------------- conexao

  /**
   * Cria (ou reaproveita) a sessao do gestor e a coloca em estado de leitura
   * de QR. O numero precisa estar cadastrado antes: e contra ele que a
   * identidade da sessao sera conferida.
   */
  async iniciarConexao(idUsuario: number): Promise<StatusSessaoDto> {
    const usuario = await this.usuarios.obterOuFalhar(idUsuario);
    if (!usuario.whatsappE164) {
      throw new BadRequestException(
        'Cadastre seu numero de WhatsApp antes de conectar ' +
          '(PATCH /usuarios/eu/contato). E ele que sera conferido apos a leitura do QR.',
      );
    }

    const servidor = await this.exigirServidor();
    let sessao = await this.repo.sessaoDoUsuario(idUsuario);

    if (!sessao) {
      const nome = `${this.config.waha.prefixoSessao}-${idUsuario}`;
      const conflitante = await this.repo.sessaoPorNome(nome);
      if (conflitante && conflitante.idUsuario !== idUsuario) {
        throw new ConflictException(`O nome de sessao "${nome}" ja pertence a outro gestor.`);
      }
      const id = await this.repo.criarSessao({
        idUsuario,
        idServidor: servidor.id,
        nomeSessao: nome,
      });
      sessao = (await this.repo.sessaoPorId(id))!;
    }

    const cliente = this.criarCliente(servidor);
    await cliente.iniciarSessao(sessao.nomeSessao, this.config.waha.webhookUrl || undefined);

    return this.sincronizarStatus(idUsuario);
  }

  /**
   * QR code atual, em base64.
   *
   * Nunca gravado em banco, arquivo ou log, e devolvido apenas ao proprio
   * dono da sessao. Ler o QR conecta a conta; nenhuma mensagem e enviada
   * nesse momento.
   */
  async obterQrCode(idUsuario: number): Promise<{ mimeType: string; base64: string }> {
    const { sessao, cliente } = await this.exigirSessao(idUsuario);
    return cliente.qrCodeBase64(sessao.nomeSessao);
  }

  /**
   * Le o estado no WAHA e decide se o numero esta verificado.
   *
   * Verificado = sessao WORKING e numero conectado igual ao cadastrado.
   * Qualquer coisa diferente disso derruba a verificacao, o que impede a
   * trigger AI_NOTIF_EVENTO de enfileirar avisos por WhatsApp.
   */
  async sincronizarStatus(idUsuario: number): Promise<StatusSessaoDto> {
    const usuario = await this.usuarios.obterOuFalhar(idUsuario);
    const { sessao, cliente } = await this.exigirSessao(idUsuario);

    const remoto = await cliente.status(sessao.nomeSessao);
    if (!remoto) {
      await this.repo.atualizarSessao(sessao.id, {
        situacao: 'STOPPED',
        numeroConectado: null,
        chatIdProprio: null,
        conectadoEm: null,
        ultimoErro: 'Sessao inexistente no servidor WAHA.',
      });
      await this.usuarios.marcarWhatsappVerificado(idUsuario, false);
      return this.montarStatus('STOPPED', null, usuario.whatsappE164 ?? null, null, null);
    }

    const numeroConectado = remoto.numero
      ? paraE164(remoto.numero, this.config.waha.codigoPaisPadrao)
      : null;
    const cadastrado = usuario.whatsappE164 ?? null;
    const conferem = Boolean(numeroConectado && cadastrado && numeroConectado === cadastrado);
    const verificado = remoto.situacao === 'WORKING' && conferem;

    await this.repo.atualizarSessao(sessao.id, {
      situacao: remoto.situacao,
      numeroConectado,
      chatIdProprio: remoto.chatIdProprio ?? (numeroConectado ? e164ParaChatId(numeroConectado) : null),
      conectadoEm: verificado ? (sessao.conectadoEm ?? new Date()) : null,
      ultimoErro:
        remoto.situacao === 'WORKING' && !conferem
          ? `O WhatsApp conectado (${numeroConectado ?? 'desconhecido'}) e diferente do numero ` +
            `cadastrado (${cadastrado ?? 'nenhum'}).`
          : null,
    });

    await this.usuarios.marcarWhatsappVerificado(idUsuario, verificado);

    return this.montarStatus(
      remoto.situacao,
      numeroConectado,
      cadastrado,
      verificado ? new Date() : null,
      remoto.situacao === 'WORKING' && !conferem
        ? 'O numero conectado nao confere com o cadastrado.'
        : null,
    );
  }

  async status(idUsuario: number): Promise<StatusSessaoDto | null> {
    const sessao = await this.repo.sessaoDoUsuario(idUsuario);
    if (!sessao) return null;
    return this.sincronizarStatus(idUsuario);
  }

  /** Desconecta a conta e derruba a verificacao do numero. */
  async desconectar(idUsuario: number): Promise<void> {
    const { sessao, cliente } = await this.exigirSessao(idUsuario);
    await cliente.desconectar(sessao.nomeSessao).catch((erro) => {
      this.logger.warn(`Logout no WAHA falhou: ${(erro as Error).message}`);
    });
    await this.repo.atualizarSessao(sessao.id, {
      situacao: 'STOPPED',
      numeroConectado: null,
      chatIdProprio: null,
      conectadoEm: null,
      ultimoErro: null,
    });
    await this.usuarios.marcarWhatsappVerificado(idUsuario, false);
  }

  async remover(idUsuario: number): Promise<void> {
    const sessao = await this.repo.sessaoDoUsuario(idUsuario);
    if (!sessao) return;
    await this.desconectar(idUsuario).catch(() => undefined);
    await this.repo.removerSessao(sessao.id);
    await this.usuarios.marcarWhatsappVerificado(idUsuario, false);
  }

  /**
   * Checagem imediatamente antes de cada envio, como manda o contrato:
   * sessao WORKING, numero conferindo e sessao do proprio destinatario.
   */
  async prepararEnvio(
    idSessao: number,
    idUsuarioEsperado: number,
    numeroEsperado: string,
  ): Promise<{ cliente: WahaClient; chatId: string; sessao: SessaoWaha }> {
    const sessao = await this.repo.sessaoPorId(idSessao);
    if (!sessao) throw new NotFoundException('Sessao de WhatsApp nao encontrada.');

    if (sessao.idUsuario !== idUsuarioEsperado) {
      // Nunca cair na sessao de outro gestor, em nenhuma hipotese.
      throw new BadRequestException('A sessao nao pertence ao destinatario do aviso.');
    }

    const servidor = await this.repo.servidorPorId(sessao.idServidor);
    if (!servidor?.ativo) throw new BadRequestException('Servidor WAHA indisponivel.');

    const cliente = this.criarCliente(servidor);
    const remoto = await cliente.status(sessao.nomeSessao);

    if (!remoto || remoto.situacao !== 'WORKING') {
      throw new BadRequestException(
        `A sessao de WhatsApp esta em ${remoto?.situacao ?? 'STOPPED'}; e preciso reconectar.`,
      );
    }

    const numeroConectado = remoto.numero
      ? paraE164(remoto.numero, this.config.waha.codigoPaisPadrao)
      : null;
    if (numeroConectado !== numeroEsperado) {
      throw new BadRequestException(
        'O numero conectado mudou e nao confere mais com o cadastrado. ' +
          'O aviso nao sera enviado ate uma nova verificacao.',
      );
    }

    const chatId = remoto.chatIdProprio ?? e164ParaChatId(numeroEsperado);
    return { cliente, chatId, sessao };
  }

  // ---------------------------------------------------------------- apoio

  private async exigirServidor(): Promise<ServidorWaha> {
    const servidor = await this.repo.servidorAtivo();
    if (!servidor) {
      throw new BadRequestException(
        'Nenhum servidor WAHA cadastrado. Preencha WAHA_BASE_URL e WAHA_API_KEY no .env.',
      );
    }
    return servidor;
  }

  private async exigirSessao(
    idUsuario: number,
  ): Promise<{ sessao: SessaoWaha; cliente: WahaClient; servidor: ServidorWaha }> {
    const sessao = await this.repo.sessaoDoUsuario(idUsuario);
    if (!sessao) {
      throw new NotFoundException(
        'Voce ainda nao tem uma sessao de WhatsApp. Use POST /waha/conectar para comecar.',
      );
    }
    const servidor = await this.repo.servidorPorId(sessao.idServidor);
    if (!servidor) throw new NotFoundException('Servidor WAHA da sessao nao existe mais.');
    return { sessao, cliente: this.criarCliente(servidor), servidor };
  }

  private montarStatus(
    situacao: string,
    numeroConectado: string | null,
    numeroCadastrado: string | null,
    conectadoEm: Date | null,
    erro: string | null,
  ): StatusSessaoDto {
    const conferem = Boolean(
      numeroConectado && numeroCadastrado && numeroConectado === numeroCadastrado,
    );
    const verificado = situacao === 'WORKING' && conferem;

    let proximoPasso: string;
    if (verificado) proximoPasso = 'Tudo certo: os avisos por WhatsApp podem ser enviados.';
    else if (situacao === 'SCAN_QR_CODE') proximoPasso = 'Leia o QR code em GET /waha/qrcode.';
    else if (situacao === 'STARTING') proximoPasso = 'A sessao esta iniciando; consulte de novo em alguns segundos.';
    else if (situacao === 'WORKING' && !conferem)
      proximoPasso =
        'O WhatsApp conectado e de outro numero. Desconecte e leia o QR com o celular cadastrado.';
    else proximoPasso = 'Inicie a conexao em POST /waha/conectar.';

    return {
      situacao,
      numeroConectado,
      numeroCadastrado,
      numerosConferem: conferem,
      verificado,
      conectadoEm,
      ultimoErro: erro,
      proximoPasso,
    };
  }
}
