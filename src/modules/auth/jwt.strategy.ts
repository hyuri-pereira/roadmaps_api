import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { PayloadJwt, UsuarioAutenticado } from '../../common/auth.types';
import { UsuariosRepository } from '../usuarios/usuarios.repository';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(CONFIG_APP) config: AppConfig,
    private readonly usuarios: UsuariosRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.seguranca.jwtSegredo,
      issuer: config.seguranca.jwtIssuer,
    });
  }

  /**
   * Relemos o usuario a cada requisicao de proposito: desativar alguem ou
   * trocar o perfil passa a valer imediatamente, sem esperar o access token
   * expirar.
   */
  async validate(payload: PayloadJwt): Promise<UsuarioAutenticado> {
    const usuario = await this.usuarios.porId(payload.sub);
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException('Usuario inexistente ou desativado.');
    }
    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
    };
  }
}
