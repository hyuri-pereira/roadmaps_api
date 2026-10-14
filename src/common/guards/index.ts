import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CHAVE_PERFIS, CHAVE_PUBLICO } from '../decorators';
import { Perfil, UsuarioAutenticado } from '../auth.types';

/**
 * Guard global. Exige JWT em tudo, exceto nas rotas marcadas com @Publico().
 *
 * O perfil gravado no banco nao implementa seguranca por linha sozinho:
 * cada service ainda valida dono do roadmap e participacao na equipe.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(contexto: ExecutionContext) {
    const publico = this.reflector.getAllAndOverride<boolean>(CHAVE_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (publico) return true;
    return super.canActivate(contexto);
  }

  handleRequest<T = UsuarioAutenticado>(erro: unknown, usuario: T): T {
    if (erro || !usuario) {
      throw new UnauthorizedException('Token de acesso ausente, invalido ou expirado.');
    }
    return usuario;
  }
}

@Injectable()
export class PerfisGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const exigidos = this.reflector.getAllAndOverride<Perfil[]>(CHAVE_PERFIS, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (!exigidos?.length) return true;

    const usuario: UsuarioAutenticado = contexto.switchToHttp().getRequest().user;
    if (!usuario) throw new UnauthorizedException();

    if (!exigidos.includes(usuario.perfil)) {
      throw new ForbiddenException(
        `Esta operacao exige um dos perfis: ${exigidos.join(', ')}. Seu perfil e ${usuario.perfil}.`,
      );
    }
    return true;
  }
}
