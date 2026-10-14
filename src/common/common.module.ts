import { Global, Module } from '@nestjs/common';
import { CONFIG_APP, carregarConfiguracao } from './config/configuration';
import { CryptoService } from './crypto/crypto.service';

/**
 * Modulo global com a configuracao ja validada e o servico de criptografia.
 * Tudo que precisa de .env recebe CONFIG_APP por injecao.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG_APP,
      useFactory: carregarConfiguracao,
    },
    CryptoService,
  ],
  exports: [CONFIG_APP, CryptoService],
})
export class CommonModule {}
