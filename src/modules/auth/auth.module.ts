import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessoesRepository } from './auth-sessoes.repository';
import { GoogleService } from './google.service';
import { JwtStrategy } from './jwt.strategy';
import { OAuthEstadosRepository } from './oauth-estados.repository';

@Module({
  imports: [
    UsuariosModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [CONFIG_APP],
      useFactory: (config: AppConfig) => ({
        secret: config.seguranca.jwtSegredo,
        signOptions: {
          expiresIn: config.seguranca.jwtAccessTtl,
          issuer: config.seguranca.jwtIssuer,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    GoogleService,
    JwtStrategy,
    AuthSessoesRepository,
    OAuthEstadosRepository,
  ],
  exports: [AuthService, OAuthEstadosRepository, AuthSessoesRepository],
})
export class AuthModule {}
