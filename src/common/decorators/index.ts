import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Perfil, UsuarioAutenticado } from '../auth.types';

export const CHAVE_PUBLICO = 'rota_publica';
export const CHAVE_PERFIS = 'perfis_exigidos';

/** Marca a rota como acessivel sem JWT (login, callbacks OAuth, webhooks). */
export const Publico = () => SetMetadata(CHAVE_PUBLICO, true);

/** Restringe a rota a determinados perfis. Use junto com PerfisGuard. */
export const Perfis = (...perfis: Perfil[]) => SetMetadata(CHAVE_PERFIS, perfis);

/** Injeta o usuario autenticado no handler. */
export const UsuarioAtual = createParamDecorator(
  (campo: keyof UsuarioAutenticado | undefined, contexto: ExecutionContext) => {
    const requisicao = contexto.switchToHttp().getRequest();
    const usuario: UsuarioAutenticado = requisicao.user;
    return campo ? usuario?.[campo] : usuario;
  },
);
