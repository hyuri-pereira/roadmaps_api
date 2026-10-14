import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { PaginacaoDto, RespostaPaginadaDto } from '../../common/dto';
import { paraE164 } from '../../common/utils';
import { Perfil } from '../../common/auth.types';
import {
  AtualizarContatoDto,
  AtualizarUsuarioDto,
  CriarUsuarioDto,
  DefinirSenhaDto,
  UsuarioDto,
} from './usuarios.dto';
import { UsuarioComSenha, UsuariosRepository, semSegredo } from './usuarios.repository';

/** Parametros do Argon2id. Custo equilibrado para uma API interna. */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class UsuariosService {
  private readonly logger = new Logger(UsuariosService.name);

  constructor(
    private readonly repo: UsuariosRepository,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  async listar(paginacao: PaginacaoDto): Promise<RespostaPaginadaDto<UsuarioDto>> {
    const { itens, total } = await this.repo.listar(
      paginacao.busca,
      paginacao.offset,
      paginacao.tamanho,
    );
    return RespostaPaginadaDto.de(itens.map(semSegredo), total, paginacao);
  }

  async obter(id: number): Promise<UsuarioDto> {
    return semSegredo(await this.obterOuFalhar(id));
  }

  async obterOuFalhar(id: number): Promise<UsuarioComSenha> {
    const usuario = await this.repo.porId(id);
    if (!usuario) throw new NotFoundException(`Usuario ${id} nao encontrado.`);
    return usuario;
  }

  async criar(dto: CriarUsuarioDto): Promise<UsuarioDto> {
    const existente = await this.repo.porEmail(dto.email);
    if (existente) throw new ConflictException('Ja existe um usuario com esse e-mail.');

    const id = await this.repo.criar({
      nome: dto.nome,
      email: dto.email.toLowerCase(),
      senhaHash: dto.senha ? await hash(dto.senha, ARGON2) : null,
      perfil: dto.perfil ?? 'GESTOR',
    });
    return this.obter(id);
  }

  async atualizar(id: number, dto: AtualizarUsuarioDto): Promise<UsuarioDto> {
    await this.obterOuFalhar(id);
    await this.repo.atualizar(id, {
      ...(dto.nome !== undefined ? { NOME: dto.nome } : {}),
      ...(dto.perfil !== undefined ? { PERFIL: dto.perfil } : {}),
      ...(dto.ativo !== undefined ? { ATIVO: dto.ativo } : {}),
    });
    return this.obter(id);
  }

  /**
   * Contato usado pelas notificacoes.
   *
   * Trocar o e-mail zera EMAIL_VERIFICADO_EM e trocar o celular zera
   * WHATSAPP_VERIFICADO_EM, porque a trigger AI_NOTIF_EVENTO so enfileira
   * avisos para contatos verificados. Sem isso, mudar o numero silenciosamente
   * mandaria mensagem para o dono anterior daquela sessao.
   */
  async atualizarContato(id: number, dto: AtualizarContatoDto): Promise<UsuarioDto> {
    const atual = await this.obterOuFalhar(id);
    const campos: Record<string, unknown> = {};

    if (dto.emailNotificacao !== undefined) {
      const novo = dto.emailNotificacao ? dto.emailNotificacao.toLowerCase() : null;
      if (novo !== atual.emailNotificacao) {
        campos.EMAIL_NOTIFICACAO = novo;
        campos.EMAIL_VERIFICADO_EM = null;
      }
    }

    if (dto.whatsapp !== undefined) {
      let novo: string | null = null;
      if (dto.whatsapp) {
        novo = paraE164(dto.whatsapp, this.config.waha.codigoPaisPadrao);
        if (!novo) {
          throw new BadRequestException(
            'Numero de WhatsApp invalido. Use DDD + numero, ex.: (11) 91234-5678.',
          );
        }
      }
      if (novo !== atual.whatsappE164) {
        campos.WHATSAPP_E164 = novo;
        campos.WHATSAPP_VERIFICADO_EM = null;
      }
    }

    if (Object.keys(campos).length) {
      await this.repo.atualizar(id, campos);
      this.logger.log(`Contato do usuario ${id} atualizado; verificacoes afetadas foram zeradas.`);
    }
    return this.obter(id);
  }

  async definirSenha(id: number, dto: DefinirSenhaDto): Promise<void> {
    const usuario = await this.obterOuFalhar(id);

    if (usuario.senhaHash) {
      if (!dto.senhaAtual) {
        throw new BadRequestException('Informe a senha atual para trocar a senha.');
      }
      const confere = await verify(usuario.senhaHash, dto.senhaAtual).catch(() => false);
      if (!confere) throw new UnauthorizedException('Senha atual incorreta.');
    }

    await this.repo.atualizar(id, { SENHA_HASH: await hash(dto.novaSenha, ARGON2) });
  }

  /** Usada pelo login local. Devolve null sem revelar o motivo exato. */
  async validarCredenciais(email: string, senha: string): Promise<UsuarioComSenha | null> {
    const usuario = await this.repo.porEmail(email);
    if (!usuario?.senhaHash || !usuario.ativo) return null;
    const confere = await verify(usuario.senhaHash, senha).catch(() => false);
    return confere ? usuario : null;
  }

  /** Login social: casa por subject e, na ausencia, por e-mail. */
  async resolverPorProvedor(dados: {
    provedor: string;
    subject: string;
    email: string;
    nome: string;
    avatarUrl?: string | null;
  }): Promise<UsuarioComSenha> {
    const porSubject = await this.repo.porProvedor(dados.provedor, dados.subject);
    if (porSubject) {
      if (!porSubject.ativo) throw new UnauthorizedException('Usuario inativo.');
      await this.repo.atualizar(porSubject.id, {
        AVATAR_URL: dados.avatarUrl ?? porSubject.avatarUrl ?? null,
        ULTIMO_LOGIN_EM: new Date(),
      });
      return (await this.repo.porId(porSubject.id))!;
    }

    const porEmail = await this.repo.porEmail(dados.email);
    if (porEmail) {
      if (!porEmail.ativo) throw new UnauthorizedException('Usuario inativo.');
      // Primeiro login social de uma conta que ja existia: vincula o provedor.
      await this.repo.atualizar(porEmail.id, {
        AUTH_PROVEDOR: dados.provedor,
        AUTH_SUBJECT: dados.subject,
        AVATAR_URL: dados.avatarUrl ?? null,
        ULTIMO_LOGIN_EM: new Date(),
      });
      return (await this.repo.porId(porEmail.id))!;
    }

    if (!this.config.google.autoProvisionar) {
      throw new UnauthorizedException(
        'Este e-mail nao esta cadastrado. Peca a um administrador para criar seu acesso.',
      );
    }

    // O primeiro usuario do sistema vira ADMIN; os demais entram como GESTOR.
    const total = await this.repo.contar();
    const perfil: Perfil = total === 0 ? 'ADMIN' : 'GESTOR';

    const id = await this.repo.criar({
      nome: dados.nome,
      email: dados.email.toLowerCase(),
      perfil,
      authProvedor: dados.provedor,
      authSubject: dados.subject,
      avatarUrl: dados.avatarUrl ?? null,
      // O e-mail ja foi verificado pelo Google; serve direto para avisos.
      emailNotificacao: dados.email.toLowerCase(),
      emailVerificadoEm: new Date(),
    });
    this.logger.log(`Usuario ${dados.email} criado via ${dados.provedor} com perfil ${perfil}.`);
    return (await this.repo.porId(id))!;
  }

  async marcarEmailVerificado(id: number): Promise<void> {
    await this.repo.atualizar(id, { EMAIL_VERIFICADO_EM: new Date() });
  }

  async marcarWhatsappVerificado(id: number, verificado: boolean): Promise<void> {
    await this.repo.atualizar(id, { WHATSAPP_VERIFICADO_EM: verificado ? new Date() : null });
  }

  async registrarLogin(id: number): Promise<void> {
    await this.repo.registrarLogin(id);
  }
}
