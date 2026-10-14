import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha, TransacaoFirebird } from '../../database/drivers/driver.interface';
import { paraBooleano, paraDataOuNulo, truncar } from '../../common/utils';
import { EquipeAsanaDto, ProjetoAsanaDto, SecaoAsanaDto, WorkspaceDto } from './asana-catalogo.dto';

/**
 * O catalogo e UNICO para todos os gestores: uma linha por GID do Asana,
 * independente de qual credencial fez a leitura. Por isso todas as gravacoes
 * sao UPDATE OR INSERT por GID, e nunca INSERT direto.
 */
@Injectable()
export class AsanaCatalogoRepository {
  constructor(private readonly db: FirebirdService) {}

  // ------------------------------------------------------------ workspaces

  async upsertWorkspace(
    tx: TransacaoFirebird,
    dados: { gid: string; nome: string; tipo?: string | null },
  ): Promise<number> {
    const linha = await tx.queryUm<{ ID_ASANA_WORKSPACE: number }>(
      `UPDATE OR INSERT INTO ASANA_WORKSPACES (ASANA_GID, NOME, TIPO_RECURSO, SINCRONIZADO_EM)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (ASANA_GID)
       RETURNING ID_ASANA_WORKSPACE`,
      [dados.gid, truncar(dados.nome, 150)!, dados.tipo ?? null],
    );
    return Number(linha!.ID_ASANA_WORKSPACE);
  }

  async listarWorkspaces(): Promise<WorkspaceDto[]> {
    const linhas = await this.db.query(
      'SELECT ID_ASANA_WORKSPACE, ASANA_GID, NOME, SINCRONIZADO_EM FROM ASANA_WORKSPACES ORDER BY NOME',
    );
    return linhas.map((l) => ({
      id: Number(l.ID_ASANA_WORKSPACE),
      asanaGid: String(l.ASANA_GID),
      nome: String(l.NOME),
      sincronizadoEm: paraDataOuNulo(l.SINCRONIZADO_EM),
    }));
  }

  // --------------------------------------------------------------- equipes

  async upsertEquipe(
    tx: TransacaoFirebird,
    dados: { idWorkspace: number; gid: string; nome: string },
  ): Promise<number> {
    const linha = await tx.queryUm<{ ID_ASANA_EQUIPE: number }>(
      `UPDATE OR INSERT INTO ASANA_EQUIPES (ID_ASANA_WORKSPACE, ASANA_GID, NOME, SINCRONIZADO_EM)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (ID_ASANA_WORKSPACE, ASANA_GID)
       RETURNING ID_ASANA_EQUIPE`,
      [dados.idWorkspace, dados.gid, truncar(dados.nome, 150)!],
    );
    return Number(linha!.ID_ASANA_EQUIPE);
  }

  async listarEquipes(idWorkspace?: number): Promise<EquipeAsanaDto[]> {
    const filtro = idWorkspace ? 'WHERE E.ID_ASANA_WORKSPACE = ?' : '';
    const linhas = await this.db.query(
      `SELECT E.ID_ASANA_EQUIPE, E.ID_ASANA_WORKSPACE, E.ASANA_GID, E.NOME,
              IIF(D.ID_ASANA_EQUIPE IS NULL, FALSE, TRUE) AS CONFIGURADA
         FROM ASANA_EQUIPES E
         LEFT JOIN EQUIPE_DESTINOS D ON D.ID_ASANA_EQUIPE = E.ID_ASANA_EQUIPE
         ${filtro}
        ORDER BY E.NOME`,
      idWorkspace ? [idWorkspace] : [],
    );
    return linhas.map((l) => ({
      id: Number(l.ID_ASANA_EQUIPE),
      idWorkspace: Number(l.ID_ASANA_WORKSPACE),
      asanaGid: String(l.ASANA_GID),
      nome: String(l.NOME),
      configurada: paraBooleano(l.CONFIGURADA),
    }));
  }

  async equipePorId(id: number): Promise<{ id: number; gid: string; nome: string; idWorkspace: number } | null> {
    const linha = await this.db.queryUm(
      'SELECT ID_ASANA_EQUIPE, ASANA_GID, NOME, ID_ASANA_WORKSPACE FROM ASANA_EQUIPES WHERE ID_ASANA_EQUIPE = ?',
      [id],
    );
    if (!linha) return null;
    return {
      id: Number(linha.ID_ASANA_EQUIPE),
      gid: String(linha.ASANA_GID),
      nome: String(linha.NOME),
      idWorkspace: Number(linha.ID_ASANA_WORKSPACE),
    };
  }

  // -------------------------------------------------------------- projetos

  async upsertProjeto(
    tx: TransacaoFirebird,
    dados: {
      idWorkspace: number;
      idEquipe?: number | null;
      gid: string;
      nome: string;
      descricao?: string | null;
      cor?: string | null;
      layout?: string | null;
      url?: string | null;
      arquivado: boolean;
      concluido: boolean;
      modificadoEm?: Date | null;
    },
  ): Promise<number> {
    const linha = await tx.queryUm<{ ID_ASANA_PROJETO: number }>(
      `UPDATE OR INSERT INTO ASANA_PROJETOS
         (ID_ASANA_WORKSPACE, ID_ASANA_EQUIPE, ASANA_GID, NOME, DESCRICAO, COR, LAYOUT,
          URL_RECURSO, ARQUIVADO, CONCLUIDO, ASANA_MODIFICADO_EM, SINCRONIZADO_EM)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (ID_ASANA_WORKSPACE, ASANA_GID)
       RETURNING ID_ASANA_PROJETO`,
      [
        dados.idWorkspace,
        dados.idEquipe ?? null,
        dados.gid,
        truncar(dados.nome, 200)!,
        dados.descricao ?? null,
        truncar(dados.cor ?? null, 30),
        normalizarLayout(dados.layout),
        truncar(dados.url ?? null, 1000),
        dados.arquivado,
        dados.concluido,
        dados.modificadoEm ?? null,
      ],
    );
    return Number(linha!.ID_ASANA_PROJETO);
  }

  async listarProjetos(filtro: {
    idEquipe?: number;
    idWorkspace?: number;
    incluirArquivados?: boolean;
    busca?: string;
  }): Promise<ProjetoAsanaDto[]> {
    const condicoes: string[] = [];
    const parametros: unknown[] = [];

    if (filtro.idEquipe) {
      condicoes.push('P.ID_ASANA_EQUIPE = ?');
      parametros.push(filtro.idEquipe);
    }
    if (filtro.idWorkspace) {
      condicoes.push('P.ID_ASANA_WORKSPACE = ?');
      parametros.push(filtro.idWorkspace);
    }
    if (!filtro.incluirArquivados) condicoes.push('P.ARQUIVADO = FALSE');
    if (filtro.busca) {
      condicoes.push('UPPER(P.NOME) LIKE ?');
      parametros.push(`%${filtro.busca.toUpperCase()}%`);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const linhas = await this.db.query(
      `SELECT P.ID_ASANA_PROJETO, P.ASANA_GID, P.NOME, P.ID_ASANA_EQUIPE, E.NOME AS EQUIPE_NOME,
              P.COR, P.LAYOUT, P.URL_RECURSO, P.ARQUIVADO, P.CONCLUIDO,
              P.ASANA_MODIFICADO_EM, P.SINCRONIZADO_EM
         FROM ASANA_PROJETOS P
         LEFT JOIN ASANA_EQUIPES E ON E.ID_ASANA_EQUIPE = P.ID_ASANA_EQUIPE
         ${where}
        ORDER BY P.NOME`,
      parametros as never[],
    );
    return linhas.map(mapearProjeto);
  }

  async projetoPorId(id: number): Promise<ProjetoAsanaDto | null> {
    const linha = await this.db.queryUm(
      `SELECT P.ID_ASANA_PROJETO, P.ASANA_GID, P.NOME, P.ID_ASANA_EQUIPE, E.NOME AS EQUIPE_NOME,
              P.COR, P.LAYOUT, P.URL_RECURSO, P.ARQUIVADO, P.CONCLUIDO,
              P.ASANA_MODIFICADO_EM, P.SINCRONIZADO_EM
         FROM ASANA_PROJETOS P
         LEFT JOIN ASANA_EQUIPES E ON E.ID_ASANA_EQUIPE = P.ID_ASANA_EQUIPE
        WHERE P.ID_ASANA_PROJETO = ?`,
      [id],
    );
    return linha ? mapearProjeto(linha) : null;
  }

  async projetoPorGid(gid: string): Promise<{ id: number; idEquipe: number | null; idWorkspace: number } | null> {
    const linha = await this.db.queryUm(
      'SELECT ID_ASANA_PROJETO, ID_ASANA_EQUIPE, ID_ASANA_WORKSPACE FROM ASANA_PROJETOS WHERE ASANA_GID = ?',
      [gid],
    );
    if (!linha) return null;
    return {
      id: Number(linha.ID_ASANA_PROJETO),
      idEquipe: linha.ID_ASANA_EQUIPE ? Number(linha.ID_ASANA_EQUIPE) : null,
      idWorkspace: Number(linha.ID_ASANA_WORKSPACE),
    };
  }

  // ---------------------------------------------------------------- secoes

  async upsertSecao(
    tx: TransacaoFirebird,
    dados: { idProjeto: number; gid: string; nome: string; ordem: number },
  ): Promise<number> {
    const linha = await tx.queryUm<{ ID_ASANA_SECAO: number }>(
      `UPDATE OR INSERT INTO ASANA_SECOES
         (ID_ASANA_PROJETO, ASANA_GID, NOME, ORDEM, ATIVO, SINCRONIZADO_EM)
       VALUES (?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)
       MATCHING (ID_ASANA_PROJETO, ASANA_GID)
       RETURNING ID_ASANA_SECAO`,
      [dados.idProjeto, dados.gid, truncar(dados.nome, 200)!, dados.ordem],
    );
    return Number(linha!.ID_ASANA_SECAO);
  }

  /**
   * Secoes apagadas no Asana viram inativas aqui, e nao DELETE: cards e
   * membresias historicas continuam apontando para elas.
   */
  async desativarSecoesAusentes(
    tx: TransacaoFirebird,
    idProjeto: number,
    gidsPresentes: string[],
  ): Promise<void> {
    if (!gidsPresentes.length) {
      await tx.executar('UPDATE ASANA_SECOES SET ATIVO = FALSE WHERE ID_ASANA_PROJETO = ?', [
        idProjeto,
      ]);
      return;
    }
    const marcadores = gidsPresentes.map(() => '?').join(',');
    await tx.executar(
      `UPDATE ASANA_SECOES SET ATIVO = FALSE
        WHERE ID_ASANA_PROJETO = ? AND ASANA_GID NOT IN (${marcadores})`,
      [idProjeto, ...gidsPresentes] as never[],
    );
  }

  async listarSecoes(idProjeto: number, incluirInativas = false): Promise<SecaoAsanaDto[]> {
    const filtro = incluirInativas ? '' : 'AND ATIVO = TRUE';
    const linhas = await this.db.query(
      `SELECT ID_ASANA_SECAO, ID_ASANA_PROJETO, ASANA_GID, NOME, ORDEM, ATIVO
         FROM ASANA_SECOES
        WHERE ID_ASANA_PROJETO = ? ${filtro}
        ORDER BY ORDEM, NOME`,
      [idProjeto],
    );
    return linhas.map((l) => ({
      id: Number(l.ID_ASANA_SECAO),
      idProjeto: Number(l.ID_ASANA_PROJETO),
      asanaGid: String(l.ASANA_GID),
      nome: String(l.NOME),
      ordem: Number(l.ORDEM),
      ativo: paraBooleano(l.ATIVO),
    }));
  }

  async secaoPorGid(gid: string): Promise<{ id: number; idProjeto: number; nome: string } | null> {
    const linha = await this.db.queryUm(
      'SELECT ID_ASANA_SECAO, ID_ASANA_PROJETO, NOME FROM ASANA_SECOES WHERE ASANA_GID = ?',
      [gid],
    );
    if (!linha) return null;
    return {
      id: Number(linha.ID_ASANA_SECAO),
      idProjeto: Number(linha.ID_ASANA_PROJETO),
      nome: String(linha.NOME),
    };
  }

  async gidDoProjeto(id: number): Promise<string | null> {
    const linha = await this.db.queryUm<{ ASANA_GID: string }>(
      'SELECT ASANA_GID FROM ASANA_PROJETOS WHERE ID_ASANA_PROJETO = ?',
      [id],
    );
    return linha?.ASANA_GID ?? null;
  }

  async gidDaSecao(id: number): Promise<string | null> {
    const linha = await this.db.queryUm<{ ASANA_GID: string }>(
      'SELECT ASANA_GID FROM ASANA_SECOES WHERE ID_ASANA_SECAO = ?',
      [id],
    );
    return linha?.ASANA_GID ?? null;
  }

  async gidDoWorkspaceDoProjeto(idProjeto: number): Promise<string | null> {
    const linha = await this.db.queryUm<{ ASANA_GID: string }>(
      `SELECT W.ASANA_GID
         FROM ASANA_PROJETOS P
         JOIN ASANA_WORKSPACES W ON W.ID_ASANA_WORKSPACE = P.ID_ASANA_WORKSPACE
        WHERE P.ID_ASANA_PROJETO = ?`,
      [idProjeto],
    );
    return linha?.ASANA_GID ?? null;
  }
}

function mapearProjeto(l: Linha): ProjetoAsanaDto {
  return {
    id: Number(l.ID_ASANA_PROJETO),
    asanaGid: String(l.ASANA_GID),
    nome: String(l.NOME),
    idEquipe: l.ID_ASANA_EQUIPE ? Number(l.ID_ASANA_EQUIPE) : null,
    equipeNome: (l.EQUIPE_NOME as string) ?? null,
    cor: (l.COR as string) ?? null,
    layout: (l.LAYOUT as string) ?? null,
    urlRecurso: (l.URL_RECURSO as string) ?? null,
    arquivado: paraBooleano(l.ARQUIVADO),
    concluido: paraBooleano(l.CONCLUIDO),
    asanaModificadoEm: paraDataOuNulo(l.ASANA_MODIFICADO_EM),
    sincronizadoEm: paraDataOuNulo(l.SINCRONIZADO_EM),
  };
}

/** O CHECK do schema so aceita alguns valores; o Asana manda outros nomes. */
function normalizarLayout(layout?: string | null): string | null {
  if (!layout) return null;
  const mapa: Record<string, string> = {
    list: 'LIST',
    board: 'BOARD',
    calendar: 'CALENDAR',
    timeline: 'TIMELINE',
    gantt: 'GANTT',
  };
  return mapa[layout.toLowerCase()] ?? null;
}
