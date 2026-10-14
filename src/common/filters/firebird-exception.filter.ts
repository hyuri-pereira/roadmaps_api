import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErroFirebird } from '../../database/drivers/driver.interface';

/**
 * Traduz as EXCEPTIONs do banco em respostas HTTP com mensagem util.
 *
 * As regras de negocio moram em triggers e procedures; sem esta traducao o
 * cliente receberia apenas "500 Internal Server Error" para algo que e, na
 * verdade, um 409/422 perfeitamente explicavel.
 */
const EXCECOES_BANCO: Record<string, { status: number; mensagem: string }> = {
  EX_SECAO_FORA_PROJETO: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    mensagem: 'A secao informada nao pertence ao projeto configurado.',
  },
  EX_PROJETOS_CONEXOES_DIF: {
    status: HttpStatus.FORBIDDEN,
    mensagem: 'A conexao Asana usada precisa pertencer ao gestor dono do roadmap.',
  },
  EX_SPRINT_NAO_CONFIGURADA: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    mensagem:
      'Configure o projeto de SPRINT da equipe antes de marcar um card para entrar na sprint.',
  },
  EX_ROADMAP_INEXISTENTE: {
    status: HttpStatus.NOT_FOUND,
    mensagem: 'Roadmap nao encontrado.',
  },
  EX_ROADMAP_SEM_ITENS: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    mensagem: 'Nao e possivel concluir um roadmap que nao tem nenhum card.',
  },
  EX_ROADMAP_JA_ENCERRADO: {
    status: HttpStatus.CONFLICT,
    mensagem: 'Este roadmap ja esta concluido, cancelado ou com conclusao em andamento.',
  },
  EX_CONFIG: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    mensagem:
      'Configuracao ausente ou invalida: confira os destinos da equipe (SPRINT/Backlog) e ' +
      'se o gestor tem permissao de edicao nessa equipe.',
  },
  EX_PURGA: {
    status: HttpStatus.CONFLICT,
    mensagem:
      'A exclusao fisica so acontece depois que o Asana confirmar a remocao. ' +
      'Use a exclusao normal, que e logica.',
  },
};

/** Violacoes de integridade que merecem 409 em vez de 500. */
const GDS_UNIQUE = 335544665; // violation of PRIMARY or UNIQUE KEY constraint
const GDS_FK = 335544466; // violation of FOREIGN KEY constraint
const GDS_CHECK = 335544558; // Operation violates CHECK constraint
const GDS_NOT_NULL = 335544347; // validation error for column ... value "*** null ***"

@Catch(ErroFirebird)
export class FirebirdExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FirebirdExceptionFilter.name);

  catch(erro: ErroFirebird, host: ArgumentsHost) {
    const contexto = host.switchToHttp();
    const resposta = contexto.getResponse<Response>();
    const requisicao = contexto.getRequest<Request>();

    const traduzido = this.traduzir(erro);

    if (traduzido.status >= 500) {
      this.logger.error(
        `${requisicao.method} ${requisicao.url} -> erro Firebird: ${erro.message}`,
        erro.sql,
      );
    } else {
      this.logger.warn(`${requisicao.method} ${requisicao.url} -> ${traduzido.mensagem}`);
    }

    resposta.status(traduzido.status).json({
      statusCode: traduzido.status,
      message: traduzido.mensagem,
      error: traduzido.codigo,
      path: requisicao.url,
      timestamp: new Date().toISOString(),
    });
  }

  private traduzir(erro: ErroFirebird): { status: number; mensagem: string; codigo: string } {
    const texto = erro.message ?? '';

    for (const [nome, regra] of Object.entries(EXCECOES_BANCO)) {
      if (texto.includes(nome)) {
        return { status: regra.status, mensagem: regra.mensagem, codigo: nome };
      }
    }

    switch (erro.gdscode) {
      case GDS_UNIQUE:
        return {
          status: HttpStatus.CONFLICT,
          mensagem: 'Ja existe um registro com esse valor unico.',
          codigo: 'REGISTRO_DUPLICADO',
        };
      case GDS_FK:
        return {
          status: HttpStatus.CONFLICT,
          mensagem: 'Existe vinculo com outro registro que impede esta operacao.',
          codigo: 'VINCULO_EXISTENTE',
        };
      case GDS_CHECK:
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          mensagem: 'Um valor informado viola uma regra do banco (CHECK).',
          codigo: 'REGRA_VIOLADA',
        };
      case GDS_NOT_NULL:
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          mensagem: 'Um campo obrigatorio ficou sem valor.',
          codigo: 'CAMPO_OBRIGATORIO',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          mensagem: 'Erro ao acessar o banco de dados.',
          codigo: 'ERRO_BANCO',
        };
    }
  }
}

/** Mantem o formato de resposta igual para os erros comuns do Nest. */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(erro: HttpException, host: ArgumentsHost) {
    const contexto = host.switchToHttp();
    const resposta = contexto.getResponse<Response>();
    const requisicao = contexto.getRequest<Request>();
    const status = erro.getStatus();
    const corpo = erro.getResponse();

    resposta.status(status).json({
      statusCode: status,
      message: typeof corpo === 'string' ? corpo : ((corpo as any).message ?? erro.message),
      error: typeof corpo === 'object' ? ((corpo as any).error ?? erro.name) : erro.name,
      path: requisicao.url,
      timestamp: new Date().toISOString(),
    });
  }
}
