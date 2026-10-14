import { Global, Module } from '@nestjs/common';
import { FirebirdService } from './firebird.service';

@Global()
@Module({
  providers: [FirebirdService],
  exports: [FirebirdService],
})
export class DatabaseModule {}
