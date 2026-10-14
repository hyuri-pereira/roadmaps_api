import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { CryptoService } from '../../common/crypto/crypto.service';
import { UsuarioAutenticado } from '../../common/auth.types';
import {
  AsanaClient,
  ErroAsana,
  RegistroChamadaAsana,
} from '../../integrations/asana/asana.client';
import { AsanaTokenOAuth } from '../../integrations/asana/asana.types';
import { OAuthEstadosRepository } from '../auth/oauth-estados.repository';
import {
  AtualizarConexaoDto,
  ConexaoAsanaDto,
  CriarConexaoPatDto,
  TestarConexaoDto,
} from './asana-conexoes.dto';
import {
  AsanaConexoesRepository,
  ConexaoAsanaInterna,
  semCredenciais,
} from './asana-conexoes.repository';

const PROPOSITO_ACCESS = 'asana:access_token';
const PROPOSITO_REFRESH = 'asana:refresh_token';
/** Renova o token um pouco antes de expirar, para nao perder a corrida. */
const MARGEM_RENOVACAO_MS = 120_000;

@Injectable()
export class AsanaConexoesService {
  private readonly logger = new Logger(AsanaConexoesService.name);

  constructor(
    private readonly repo: AsanaConexoesRepository,
    private readonly crypto: CryptoService,
    private readonly estados: OAuthEstadosRepository,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------- consulta

  async listar(idUsuario: number): Promise<ConexaoAsanaDto[]> {
    const conexoes = await this.repo.listarDoUsuario(idUsuario);
    return conexoes.map(semCredenciais);
  }

  async obterDoUsuario(id: number, usuario: UsuarioAutenticado): Promise<ConexaoAsanaInterna> {
    const conexao = await this.repo.porId(id);
    if (!conexao) throw new NotFoundException(`Conexao Asana ${id} nao encontrada.`);
    // Uma credencial e pessoal: nem ADMIN opera com o token de outro gestor.
    if (conexao.idUsuario !== usuario.id) {
      throw new ForbiddenException('Esta conexao Asana pertence a outro gestor.');
    }
    return conexao;
  }

  // ------------------------------------------------------------------ PAT

  async criarComPat(idUsuario: number, dto: CriarConexaoPatDto): Promise<ConexaoAsanaDto> {
    // Valida o token ANTES de gravar: conexao quebrada no banco so atrapalha.
    const identidade = await this.validarToken(dto.token);

    const envelope = this.crypto.cifrar(dto.token, PROPOSITO_ACCESS);
    const id = await this.repo.criar({
      idUsuario,
      nome: dto.nome,
      tipo: 'PAT',
      accessTokenCifrado: envelope.conteudo,
      nonceAccess: envelope.nonceBase64,
      versaoChave: envelope.versaoChave,
      usuarioGid: identidade.gid,
      usuarioNome: identidade.nome,
      usuarioEmail: identidade.email,
    });

    this.logger.log(`Conexao PAT ${id} criada para o usuario ${idUsuario}.`);
    return semCredenciais((await this.repo.porId(id))!);
  }

  async atualizar(
    id: number,
    usuario: UsuarioAutenticado,
    dto: AtualizarConexaoDto,
  ): Promise<ConexaoAsanaDto> {
    const conexao = await this.obterDoUsuario(id, usuario);

    if (dto.nome) await this.repo.renomear(id, dto.nome);

    if (dto.token) {
      if (conexao.tipoAutenticacao !== 'PAT') {
        throw new BadRequestException(
          'Esta conexao usa OAuth. Para trocar a credencial, autorize novamente pelo Asana.',
        );
      }
      const identidade = await this.validarToken(dto.token);
      const envelope = this.crypto.cifrar(dto.token, PROPOSITO_ACCESS);
      await this.repo.atualizarToken(id, {
        accessTokenCifrado: envelope.conteudo,
        nonceAccess: envelope.nonceBase64,
        versaoChave: envelope.versaoChave,
      });
      await this.repo.atualizarIdentidade(id, identidade);
    }

    return semCredenciais((await this.repo.porId(id))!);
  }

  // ---------------------------------------------------------------- OAuth

  garantirOAuthConfigurado(): void {
    if (!this.config.asana.oauthConfigurado) {
      throw new BadRequestException(
        'OAuth do Asana nao configurado. Preencha ASANA_OAUTH_CLIENT_ID e ' +
          'ASANA_OAUTH_CLIENT_SECRET no .env, ou cadastre a conexao por PAT.',
      );
    }

    let callback: URL;
    try {
      callback = new URL(this.config.asana.oauthRedirectUri);
    } catch {
      throw new BadRequestException(
        'Configure ASANA_OAUTH_REDIRECT_URI com a URL HTTPS publica de callback cadastrada no app Asana.',
      );
    }

    if (callback.protocol !== 'https:') {
      throw new BadRequestException(
        'OAuth web do Asana exige ASANA_OAUTH_REDIRECT_URI em HTTPS. Use uma URL HTTPS publica e cadastre exatamente a mesma em Asana Developer Console > OAuth > Redirect URL.',
      );
    }
  }

  async iniciarOAuth(
    idUsuario: number,
    nome?: string,
    redirecionarPara?: string,
  ): Promise<{ url: string; estado: string }> {
    this.garantirOAuthConfigurado();

    const { estado, codeChallenge } = await this.estados.criar({
      provedor: 'ASANA',
      idUsuario,
      redirecionarPara: redirecionarPara ?? null,
      dados: { nome: nome ?? 'Asana (OAuth)' },
    });

    const parametros = new URLSearchParams({
      client_id: this.config.asana.oauthClientId,
      redirect_uri: this.config.asana.oauthRedirectUri,
      response_type: 'code',
      state: estado,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: this.config.asana.oauthScopes,
    });

    return { url: `${this.config.asana.oauthAuthorizeUrl}?${parametros.toString()}`, estado };
  }

  async concluirOAuth(
    codigo: string,
    estado: string,
  ): Promise<{ conexao: ConexaoAsanaDto; redirecionarPara: string | null }> {
    this.garantirOAuthConfigurado();

    const salvo = await this.estados.consumir('ASANA', estado);
    if (!salvo?.codeVerifier || !salvo.idUsuario) {
      throw new UnauthorizedException(
        'Autorizacao expirada ou state invalido. Recomece a conexao com o Asana.',
      );
    }

    const token = await this.trocarCodigoPorToken(codigo, salvo.codeVerifier);
    const nome = String(salvo.dados?.nome ?? 'Asana (OAuth)');

    const envelopeAccess = this.crypto.cifrar(token.access_token, PROPOSITO_ACCESS);
    const envelopeRefresh = token.refresh_token
      ? this.crypto.cifrar(token.refresh_token, PROPOSITO_REFRESH)
      : null;

    const id = await this.repo.criar({
      idUsuario: salvo.idUsuario,
      nome,
      tipo: 'OAUTH2',
      accessTokenCifrado: envelopeAccess.conteudo,
      nonceAccess: envelopeAccess.nonceBase64,
      refreshTokenCifrado: envelopeRefresh?.conteudo ?? null,
      nonceRefresh: envelopeRefresh?.nonceBase64 ?? null,
      versaoChave: envelopeAccess.versaoChave,
      escopo: token.scope ?? this.config.asana.oauthScopes,
      expiraEm: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
      clientId: this.config.asana.oauthClientId,
      usuarioGid: token.data?.gid ?? null,
      usuarioNome: token.data?.name ?? null,
      usuarioEmail: token.data?.email ?? null,
    });

    this.logger.log(`Conexao OAuth ${id} criada para o usuario ${salvo.idUsuario}.`);
    return {
      conexao: semCredenciais((await this.repo.porId(id))!),
      redirecionarPara: salvo.redirecionarPara,
    };
  }

  private async trocarCodigoPorToken(
    codigo: string,
    codeVerifier: string,
  ): Promise<AsanaTokenOAuth> {
    const resposta = await axios.post(
      this.config.asana.oauthTokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.asana.oauthClientId,
        client_secret: this.config.asana.oauthClientSecret,
        redirect_uri: this.config.asana.oauthRedirectUri,
        code: codigo,
        code_verifier: codeVerifier,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: this.config.asana.timeoutMs,
        validateStatus: () => true,
      },
    );

    if (resposta.status >= 400 || !resposta.data?.access_token) {
      const detalhe = resposta.data?.error_description ?? resposta.data?.error ?? resposta.status;
      throw new UnauthorizedException(`O Asana recusou a autorizacao: ${detalhe}`);
    }
    return resposta.data as AsanaTokenOAuth;
  }

  // ------------------------------------------------------------- clientes

  /**
   * Devolve um cliente Asana pronto para a conexao informada.
   *
   * O token e resolvido a cada chamada HTTP, entao um refresh no meio de uma
   * operacao longa e transparente para quem usa o cliente.
   */
  criarCliente(
    idConexao: number,
    aoRegistrar?: (registro: RegistroChamadaAsana) => void,
  ): AsanaClient {
    return new AsanaClient({
      baseUrl: this.config.asana.baseUrl,
      timeoutMs: this.config.asana.timeoutMs,
      rateLimitPorMinuto: this.config.asana.rateLimitPorMinuto,
      obterToken: () => this.obterTokenValido(idConexao),
      aoRegistrar,
    });
  }

  /** Cliente da conexao padrao do gestor; util nas rotas interativas. */
  async criarClienteDoUsuario(idUsuario: number): Promise<{ cliente: AsanaClient; conexao: ConexaoAsanaInterna }> {
    const conexao = await this.repo.padraoDoUsuario(idUsuario);
    if (!conexao) {
      throw new BadRequestException(
        'Voce ainda nao conectou o Asana. Cadastre um PAT ou autorize via OAuth.',
      );
    }
    return { cliente: this.criarCliente(conexao.id), conexao };
  }

  async obterTokenValido(idConexao: number): Promise<string> {
    const conexao = await this.repo.porId(idConexao);
    if (!conexao) throw new NotFoundException(`Conexao Asana ${idConexao} nao encontrada.`);
    if (!conexao.ativo) {
      throw new UnauthorizedException(
        `A conexao Asana "${conexao.nome}" esta desativada. Reconecte para continuar.`,
      );
    }

    const precisaRenovar =
      conexao.tipoAutenticacao === 'OAUTH2' &&
      conexao.tokenExpiraEm !== null &&
      conexao.tokenExpiraEm !== undefined &&
      conexao.tokenExpiraEm.getTime() - MARGEM_RENOVACAO_MS <= Date.now();

    if (precisaRenovar) return this.renovarToken(conexao);

    return this.crypto.decifrar(
      conexao.accessTokenCifrado,
      PROPOSITO_ACCESS,
      conexao.versaoChave ?? undefined,
    );
  }

  private async renovarToken(conexao: ConexaoAsanaInterna): Promise<string> {
    if (!conexao.refreshTokenCifrado) {
      await this.repo.registrarErro(
        conexao.id,
        'Token OAuth expirado e sem refresh token. E preciso autorizar de novo.',
      );
      throw new UnauthorizedException(
        `A autorizacao do Asana para "${conexao.nome}" expirou. Conecte novamente.`,
      );
    }

    const refresh = this.crypto.decifrar(
      conexao.refreshTokenCifrado,
      PROPOSITO_REFRESH,
      conexao.versaoChave ?? undefined,
    );

    const resposta = await axios.post(
      this.config.asana.oauthTokenUrl,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.asana.oauthClientId,
        client_secret: this.config.asana.oauthClientSecret,
        refresh_token: refresh,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: this.config.asana.timeoutMs,
        validateStatus: () => true,
      },
    );

    if (resposta.status >= 400 || !resposta.data?.access_token) {
      const detalhe = resposta.data?.error_description ?? resposta.data?.error ?? resposta.status;
      await this.repo.registrarErro(conexao.id, `Falha ao renovar o token: ${detalhe}`);
      throw new UnauthorizedException(
        `Nao foi possivel renovar a autorizacao do Asana para "${conexao.nome}": ${detalhe}`,
      );
    }

    const token = resposta.data as AsanaTokenOAuth;
    const envelopeAccess = this.crypto.cifrar(token.access_token, PROPOSITO_ACCESS);
    // O Asana pode rotacionar o refresh token; quando vier um novo, guardamos.
    const envelopeRefresh = token.refresh_token
      ? this.crypto.cifrar(token.refresh_token, PROPOSITO_REFRESH)
      : null;

    await this.repo.atualizarToken(conexao.id, {
      accessTokenCifrado: envelopeAccess.conteudo,
      nonceAccess: envelopeAccess.nonceBase64,
      refreshTokenCifrado: envelopeRefresh?.conteudo ?? null,
      nonceRefresh: envelopeRefresh?.nonceBase64 ?? null,
      versaoChave: envelopeAccess.versaoChave,
      expiraEm: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
    });

    this.logger.debug(`Token da conexao ${conexao.id} renovado.`);
    return token.access_token;
  }

  // --------------------------------------------------------------- testes

  async testar(id: number, usuario: UsuarioAutenticado): Promise<TestarConexaoDto> {
    const conexao = await this.obterDoUsuario(id, usuario);
    const cliente = this.criarCliente(conexao.id);

    try {
      const eu = await cliente.eu();
      const workspaces = await cliente.workspaces();
      await this.repo.atualizarIdentidade(conexao.id, {
        gid: eu.gid,
        nome: eu.name ?? null,
        email: eu.email ?? null,
      });
      return {
        ok: true,
        usuario: eu.name ?? eu.gid,
        email: eu.email ?? null,
        workspaces: workspaces.map((w) => ({ gid: w.gid, nome: w.name ?? w.gid })),
      };
    } catch (erro) {
      const mensagem = erro instanceof ErroAsana ? erro.message : (erro as Error).message;
      await this.repo.registrarErro(conexao.id, mensagem);
      throw erro;
    }
  }

  async remover(id: number, usuario: UsuarioAutenticado): Promise<void> {
    const conexao = await this.obterDoUsuario(id, usuario);
    const emUso = await this.repo.contarRoadmapsAtivos(conexao.id);
    if (emUso > 0) {
      throw new ConflictException(
        `Esta conexao ainda e usada por ${emUso} roadmap(s) ativo(s). ` +
          'Conclua ou exclua esses roadmaps antes de remover a credencial.',
      );
    }
    // Desativamos em vez de apagar: a fila e a auditoria referenciam a conexao.
    await this.repo.desativar(conexao.id);
  }

  /**
   * Uma conexao por conta do Asana, para a sincronizacao agendada.
   *
   * O catalogo e compartilhado, entao ler a mesma conta do Asana duas vezes
   * (dois usuarios com o mesmo login, ou PAT e OAuth da mesma pessoa) so
   * gastaria rate limit. Contas diferentes continuam todas na lista, porque
   * cada uma pode enxergar projetos privados que as outras nao veem.
   */
  async listarParaSincronizacao(): Promise<ConexaoAsanaInterna[]> {
    const vistas = new Set<string>();
    const conexoes: ConexaoAsanaInterna[] = [];
    for (const conexao of await this.repo.listarAtivas()) {
      const identidade = conexao.asanaUsuarioGid ?? `conexao-${conexao.id}`;
      if (vistas.has(identidade)) continue;
      vistas.add(identidade);
      conexoes.push(conexao);
    }
    return conexoes;
  }

  /** Chamada pelo catalogo/worker ao fim de uma sincronizacao bem sucedida. */
  async marcarSincronizada(idConexao: number): Promise<void> {
    await this.repo.marcarSincronizada(idConexao);
  }

  async registrarErro(idConexao: number, erro: string): Promise<void> {
    await this.repo.registrarErro(idConexao, erro);
  }

  async definirPadrao(id: number, usuario: UsuarioAutenticado): Promise<void> {
    const conexao = await this.obterDoUsuario(id, usuario);
    await this.repo.definirPadrao(usuario.id, conexao.id);
  }

  /** Confere o token contra o proprio Asana e devolve a identidade. */
  private async validarToken(token: string) {
    const cliente = new AsanaClient({
      baseUrl: this.config.asana.baseUrl,
      timeoutMs: this.config.asana.timeoutMs,
      rateLimitPorMinuto: this.config.asana.rateLimitPorMinuto,
      obterToken: async () => token,
    });

    try {
      const eu = await cliente.eu();
      return { gid: eu.gid, nome: eu.name ?? null, email: eu.email ?? null };
    } catch (erro) {
      if (erro instanceof ErroAsana && erro.statusAsana === 401) {
        throw new BadRequestException(
          'O Asana recusou este token. Confira se ele foi copiado por inteiro e ainda esta valido.',
        );
      }
      throw erro;
    }
  }
}
