import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { calcularBackoffSegundos } from '../../common/utils';
import { MailService } from '../../integrations/mail/mail.service';
import { ErroWaha } from '../../integrations/waha/waha.client';
import { UsuariosService } from '../usuarios/usuarios.service';
import { WahaService } from '../waha/waha.service';
import {
  CanalNotificacao,
  ConfiguracaoEmailDto,
  DefinirPreferenciasDto,
  EVENTOS_NOTIFICACAO,
  NotificacaoFilaDto,
  PreferenciaDto,
  ResumoNotificacoesDto,
  SalvarConfiguracaoEmailDto,
} from './notificacoes.dto';
import { NotificacaoReivindicada, NotificacoesRepository } from './notificacoes.repository';
import { montarMensagem } from './mensagens.util';

@Injectable()
export class NotificacoesService {
  private readonly logger = new Logger(NotificacoesService.name);

  constructor(
    private readonly repo: NotificacoesRepository,
    private readonly usuarios: UsuariosService,
    private readonly mail: MailService,
    private readonly waha: WahaService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------- preferencias

  /**
   * Devolve a grade completa de eventos x canais, mesmo os que nunca foram
   * tocados, com a pendencia de cada canal explicada.
   */
  async preferencias(idUsuario: number): Promise<PreferenciaDto[]> {
    const usuario = await this.usuarios.obterOuFalhar(idUsuario);
    const salvas = await this.repo.preferenciasDoUsuario(idUsuario);
    const mapa = new Map(salvas.map((p) => [`${p.evento}:${p.canal}`, p]));

    const prontidao = {
      EMAIL: this.prontidaoEmail(usuario.emailNotificacao, usuario.emailVerificadoEm),
      WHATSAPP: this.prontidaoWhatsapp(usuario.whatsappE164, usuario.whatsappVerificadoEm),
    };

    const resultado: PreferenciaDto[] = [];
    for (const evento of EVENTOS_NOTIFICACAO) {
      for (const canal of ['EMAIL', 'WHATSAPP'] as CanalNotificacao[]) {
        const salva = mapa.get(`${evento}:${canal}`);
        resultado.push({
          evento,
          canal,
          ativo: salva?.ativo ?? false,
          consentimentoEm: salva?.consentimentoEm ?? null,
          pronto: prontidao[canal].pronto,
          pendencia: prontidao[canal].pendencia,
        });
      }
    }
    return resultado;
  }

  private prontidaoEmail(email: string | null | undefined, verificadoEm: Date | null | undefined) {
    if (!email) {
      return {
        pronto: false,
        pendencia: 'Informe o e-mail de aviso em PATCH /usuarios/eu/contato.',
      };
    }
    if (!verificadoEm) {
      return {
        pronto: false,
        pendencia: 'E-mail ainda nao verificado. Use POST /notificacoes/email/verificar.',
      };
    }
    return { pronto: true, pendencia: null };
  }

  private prontidaoWhatsapp(
    numero: string | null | undefined,
    verificadoEm: Date | null | undefined,
  ) {
    if (!numero) {
      return {
        pronto: false,
        pendencia: 'Informe seu celular em PATCH /usuarios/eu/contato.',
      };
    }
    if (!verificadoEm) {
      return {
        pronto: false,
        pendencia: 'Conecte o WhatsApp lendo o QR em POST /waha/conectar e GET /waha/qrcode.',
      };
    }
    return { pronto: true, pendencia: null };
  }

  /**
   * Grava as escolhas do gestor. Desligar um canal cancela imediatamente o
   * que estiver pendente nele, como manda o contrato de integracao.
   */
  async definirPreferencias(
    idUsuario: number,
    dto: DefinirPreferenciasDto,
  ): Promise<PreferenciaDto[]> {
    for (const preferencia of dto.preferencias) {
      await this.repo.definirPreferencia(
        idUsuario,
        preferencia.evento,
        preferencia.canal,
        preferencia.ativo,
      );
    }

    // Se o gestor desligou TODOS os avisos de um canal, nada pendente nele
    // deveria continuar na fila.
    for (const canal of ['EMAIL', 'WHATSAPP'] as CanalNotificacao[]) {
      const doCanal = dto.preferencias.filter((p) => p.canal === canal);
      if (doCanal.length && doCanal.every((p) => !p.ativo)) {
        const atuais = await this.repo.preferenciasDoUsuario(idUsuario);
        const aindaAtivo = atuais.some((p) => p.canal === canal && p.ativo);
        if (!aindaAtivo) {
          const cancelados = await this.repo.cancelarPendentes(
            idUsuario,
            canal,
            'O gestor desativou os avisos deste canal.',
          );
          if (cancelados) {
            this.logger.log(
              `${cancelados} aviso(s) por ${canal} cancelados para o usuario ${idUsuario}.`,
            );
          }
        }
      }
    }

    return this.preferencias(idUsuario);
  }

  /** Envia um e-mail com link de confirmacao do endereco de aviso. */
  async enviarVerificacaoEmail(idUsuario: number): Promise<{ mensagem: string }> {
    const usuario = await this.usuarios.obterOuFalhar(idUsuario);
    if (!usuario.emailNotificacao) {
      return {
        mensagem: 'Nenhum e-mail de aviso cadastrado. Informe um em PATCH /usuarios/eu/contato.',
      };
    }

    const mensagem = montarMensagem('CARD_CONCLUIDO', {
      roadmapTitulo: 'Confirmacao de e-mail',
      projeto: '-',
      cardTitulo: 'Verificacao de contato',
      cardLink: null,
      percentual: 0,
      totalCards: 0,
      cardsConcluidos: 0,
    });

    await this.mail.enviar({
      para: usuario.emailNotificacao,
      assunto: '[Roadmap] Confirmacao do e-mail de avisos',
      texto:
        'Este e um teste de entrega do Gerenciador de Roadmap.\n' +
        'Se voce recebeu esta mensagem, o endereco esta funcionando.',
      html:
        '<p>Este e um teste de entrega do <strong>Gerenciador de Roadmap</strong>.</p>' +
        '<p>Se voce recebeu esta mensagem, o endereco esta funcionando.</p>',
    });

    // Entrega bem sucedida e a propria prova de que o endereco existe.
    await this.usuarios.marcarEmailVerificado(idUsuario);
    void mensagem;

    return {
      mensagem: `E-mail de teste enviado para ${usuario.emailNotificacao}. Endereco verificado.`,
    };
  }

  listarDoUsuario(idUsuario: number): Promise<NotificacaoFilaDto[]> {
    return this.repo.listarDoUsuario(idUsuario);
  }

  resumo(): Promise<ResumoNotificacoesDto> {
    return this.repo.resumo();
  }

  // ------------------------------------------------------ config de e-mail

  async obterConfiguracaoEmail(): Promise<ConfiguracaoEmailDto | null> {
    const configuracao = await this.mail.obterConfiguracao();
    if (!configuracao) return null;
    return {
      remetenteEmail: configuracao.remetenteEmail,
      remetenteNome: configuracao.remetenteNome,
      host: configuracao.host,
      porta: configuracao.porta,
      seguranca: configuracao.seguranca,
      usuario: configuracao.usuario,
      ativo: configuracao.ativo,
      senhaDefinida: Boolean(configuracao.senha),
    };
  }

  async salvarConfiguracaoEmail(dto: SalvarConfiguracaoEmailDto): Promise<ConfiguracaoEmailDto> {
    const atual = await this.mail.obterConfiguracao();
    await this.mail.salvarConfiguracao({
      ...dto,
      // Senha em branco mantem a que ja estava gravada.
      senha: dto.senha || atual?.senha || null,
    });
    return (await this.obterConfiguracaoEmail())!;
  }

  verificarSmtp(): Promise<boolean> {
    return this.mail.verificarConexao();
  }

  // ------------------------------------------------------------- envio

  /**
   * Envia um aviso ja reivindicado da fila.
   *
   * Antes de cada envio revalidamos consentimento, destino e dono: o gestor
   * pode ter removido o contato ou desligado o aviso depois que o evento foi
   * gerado.
   */
  async enviar(notificacao: NotificacaoReivindicada): Promise<void> {
    const inicio = new Date();

    try {
      const bloqueio = await this.revalidar(notificacao);
      if (bloqueio) {
        await this.repo.marcarFalha(notificacao.id, notificacao.lockToken, bloqueio, 'CANCELADO');
        await this.repo.registrarTentativa({
          idNotificacao: notificacao.id,
          inicio,
          sucesso: false,
          codigoResposta: 'CANCELADO',
          erro: bloqueio,
        });
        return;
      }

      const contexto = await this.repo.contextoDoEvento(
        notificacao.idRoadmap,
        notificacao.idCard,
      );
      const mensagem = montarMensagem(notificacao.evento, contexto);

      const providerId =
        notificacao.canal === 'EMAIL'
          ? await this.enviarEmail(notificacao, mensagem)
          : await this.enviarWhatsapp(notificacao, mensagem.texto);

      await this.repo.marcarEnviada(notificacao.id, notificacao.lockToken, providerId);
      await this.repo.registrarTentativa({
        idNotificacao: notificacao.id,
        inicio,
        sucesso: true,
        codigoResposta: 'OK',
      });
    } catch (erro) {
      await this.tratarFalha(notificacao, erro, inicio);
    }
  }

  private async enviarEmail(
    notificacao: NotificacaoReivindicada,
    mensagem: { assunto: string; texto: string; html: string },
  ): Promise<string | null> {
    const resultado = await this.mail.enviar({
      para: notificacao.destinatario,
      assunto: mensagem.assunto,
      texto: mensagem.texto.replace(/\*/g, ''),
      html: mensagem.html,
    });
    return resultado.messageId;
  }

  private async enviarWhatsapp(
    notificacao: NotificacaoReivindicada,
    texto: string,
  ): Promise<string | null> {
    if (!notificacao.idWahaSessao) {
      throw new Error('Aviso por WhatsApp sem sessao associada.');
    }

    // A sessao precisa ser do proprio destinatario, estar WORKING e com o
    // mesmo numero. Nunca usamos a sessao de outro gestor como alternativa.
    const { cliente, chatId, sessao } = await this.waha.prepararEnvio(
      notificacao.idWahaSessao,
      notificacao.idUsuario,
      notificacao.destinatario,
    );

    const resultado = await cliente.enviarTexto(sessao.nomeSessao, chatId, texto);
    return resultado.id;
  }

  /** Confere de novo tudo que pode ter mudado desde a criacao do evento. */
  private async revalidar(notificacao: NotificacaoReivindicada): Promise<string | null> {
    const usuario = await this.usuarios.obterOuFalhar(notificacao.idUsuario);
    if (!usuario.ativo) return 'Usuario desativado.';

    const preferencias = await this.repo.preferenciasDoUsuario(notificacao.idUsuario);
    const preferencia = preferencias.find(
      (p) => p.evento === notificacao.evento && p.canal === notificacao.canal,
    );
    if (!preferencia?.ativo || !preferencia.consentimentoEm) {
      return 'O gestor desativou este aviso.';
    }

    if (notificacao.canal === 'EMAIL') {
      if (!usuario.emailNotificacao) return 'E-mail de aviso removido.';
      if (usuario.emailNotificacao !== notificacao.destinatario) {
        return 'O e-mail de aviso mudou depois que o evento foi gerado.';
      }
      if (!usuario.emailVerificadoEm) return 'E-mail de aviso ainda nao verificado.';
    } else {
      if (!usuario.whatsappE164) return 'Numero de WhatsApp removido.';
      if (usuario.whatsappE164 !== notificacao.destinatario) {
        return 'O numero de WhatsApp mudou depois que o evento foi gerado.';
      }
      if (!usuario.whatsappVerificadoEm) return 'WhatsApp nao verificado.';
    }

    return null;
  }

  private async tratarFalha(
    notificacao: NotificacaoReivindicada,
    erro: unknown,
    inicio: Date,
  ): Promise<void> {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const temporario =
      erro instanceof ErroWaha ? erro.temporario : ehFalhaTemporariaDeEmail(mensagem);

    await this.repo.registrarTentativa({
      idNotificacao: notificacao.id,
      inicio,
      sucesso: false,
      codigoResposta: temporario ? 'RETENTAR' : 'FALHA',
      erro: mensagem,
    });

    const esgotou = notificacao.tentativas >= this.config.workers.notificacaoMaxTentativas;

    if (!temporario || esgotou) {
      await this.repo.marcarFalha(
        notificacao.id,
        notificacao.lockToken,
        esgotou ? `Limite de tentativas atingido. Ultimo erro: ${mensagem}` : mensagem,
        'ERRO',
      );
      this.logger.warn(`Aviso ${notificacao.id} falhou definitivamente: ${mensagem}`);
      return;
    }

    const segundos =
      erro instanceof ErroWaha && erro.retryAfterSegundos
        ? erro.retryAfterSegundos
        : calcularBackoffSegundos(
            notificacao.tentativas,
            this.config.workers.backoffBaseSegundos,
            this.config.workers.backoffMaxSegundos,
          );

    await this.repo.reagendar(notificacao.id, notificacao.lockToken, segundos, mensagem);
  }
}

/**
 * SMTP nao tem um codigo uniforme; tratamos indisponibilidade e 4xx
 * temporarios como reententaveis e o resto como falha definitiva.
 *
 * Vale lembrar que o SMTP pode ter entregue a mensagem antes do timeout:
 * a retentativa pode gerar duplicata. Entrega exatamente uma vez nao e
 * prometida em nenhum dos dois canais.
 */
function ehFalhaTemporariaDeEmail(mensagem: string): boolean {
  const texto = mensagem.toLowerCase();
  return (
    texto.includes('timeout') ||
    texto.includes('econn') ||
    texto.includes('etimedout') ||
    texto.includes('enotfound') ||
    texto.includes('socket') ||
    texto.includes('greeting') ||
    /\b4\d\d\b/.test(texto)
  );
}
