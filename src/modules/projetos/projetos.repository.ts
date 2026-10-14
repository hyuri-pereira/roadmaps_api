import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha, TransacaoFirebird } from '../../database/drivers/driver.interface';
import { paraBooleano, paraDataOuNulo, paraNumero, truncar } from '../../common/utils';
import { FiltroProjetosLocaisDto, ProjetoDto } from './projetos.dto';

/**
 * Projeto local. O progresso vem da VW_PROJETOS_PROGRESSO (nada e
 * armazenado); o vinculo com o Asana e so a coluna ID_ASANA_PROJETO.
 */
const SELECT_BASE = `
  SELECT P.ID_PROJETO, P.NOME, P.DESCRICAO, P.COR, P.ARQUIVADO, P.ID_USUARIO_CRIADOR,
         U.NOME AS CRIADOR_NOME, P.ID_ASANA_PROJETO, AP.NOME AS ASANA_PROJETO_NOME,
         AP.URL_RECURSO AS ASANA_PROJETO_URL, AP.ID_ASANA_EQUIPE, AE.NOME AS ASANA_EQUIPE_NOME,
         P.CRIADO_EM, P.ATUALIZADO_EM,
         V.TOTAL_ROADMAPS, V.ROADMAPS_ATIVOS, V.ROADMAPS_CONCLUIDOS, V.TOTAL_CARDS,
         V.CARDS_CONCLUIDOS, V.PERCENTUAL_GERAL,
         (SELECT COUNT(*) FROM ROADMAPS R
           WHERE R.ID_PROJETO = P.ID_PROJETO AND R.EXCLUIDO_EM IS NULL
             AND R.ID_ASANA_EQUIPE IS NOT NULL) AS ROADMAPS_VINCULADOS
    FROM PROJETOS P
    JOIN VW_PROJETOS_PROGRESSO V ON V.ID_PROJETO = P.ID_PROJETO
    JOIN USUARIOS U ON U.ID_USUARIO = P.ID_USUARIO_CRIADOR
    LEFT JOIN ASANA_PROJETOS AP ON AP.ID_ASANA_PROJETO = P.ID_ASANA_PROJETO
    LEFT JOIN ASANA_EQUIPES AE ON AE.ID_ASANA_EQUIPE = AP.ID_ASANA_EQUIPE
`;

function mapear(l: Linha): ProjetoDto {
  return {
    id: Number(l.ID_PROJETO),
    nome: String(l.NOME),
    descricao: (l.DESCRICAO as string) ?? null,
    cor: (l.COR as string) ?? null,
    arquivado: paraBooleano(l.ARQUIVADO),
    idUsuarioCriador: Number(l.ID_USUARIO_CRIADOR),
    criadorNome: String(l.CRIADOR_NOME),
    idAsanaProjeto: l.ID_ASANA_PROJETO ? Number(l.ID_ASANA_PROJETO) : null,
    asanaProjetoNome: (l.ASANA_PROJETO_NOME as string) ?? null,
    asanaProjetoUrl: (l.ASANA_PROJETO_URL as string) ?? null,
    idAsanaEquipe: l.ID_ASANA_EQUIPE ? Number(l.ID_ASANA_EQUIPE) : null,
    asanaEquipeNome: (l.ASANA_EQUIPE_NOME as string) ?? null,
    totalRoadmaps: paraNumero(l.TOTAL_ROADMAPS),
    roadmapsAtivos: paraNumero(l.ROADMAPS_ATIVOS),
    roadmapsConcluidos: paraNumero(l.ROADMAPS_CONCLUIDOS),
    roadmapsVinculados: paraNumero(l.ROADMAPS_VINCULADOS),
    totalCards: paraNumero(l.TOTAL_CARDS),
    cardsConcluidos: paraNumero(l.CARDS_CONCLUIDOS),
    percentualConclusao: paraNumero(l.PERCENTUAL_GERAL),
    criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
    atualizadoEm: paraDataOuNulo(l.ATUALIZADO_EM) as Date,
  };
}

@Injectable()
export class ProjetosRepository {
  constructor(private readonly db: FirebirdService) {}

  async listar(filtro: FiltroProjetosLocaisDto): Promise<ProjetoDto[]> {
    const condicoes: string[] = [];
    const parametros: unknown[] = [];
    if (!filtro.incluirArquivados) condicoes.push('P.ARQUIVADO = FALSE');
    if (filtro.busca) {
      condicoes.push('UPPER(P.NOME) LIKE ?');
      parametros.push(`%${filtro.busca.toUpperCase()}%`);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const linhas = await this.db.query(`${SELECT_BASE} ${where} ORDER BY P.NOME`, parametros as never[]);
    return linhas.map(mapear);
  }

  async porId(id: number): Promise<ProjetoDto | null> {
    const linha = await this.db.queryUm(`${SELECT_BASE} WHERE P.ID_PROJETO = ?`, [id]);
    return linha ? mapear(linha) : null;
  }

  /** Projeto local ja vinculado a este projeto do Asana, se houver. */
  async porAsanaProjeto(idAsanaProjeto: number): Promise<{ id: number; nome: string } | null> {
    const linha = await this.db.queryUm(
      'SELECT ID_PROJETO, NOME FROM PROJETOS WHERE ID_ASANA_PROJETO = ?',
      [idAsanaProjeto],
    );
    return linha ? { id: Number(linha.ID_PROJETO), nome: String(linha.NOME) } : null;
  }

  async criar(dados: {
    nome: string;
    descricao: string | null;
    cor: string | null;
    idCriador: number;
  }): Promise<number> {
    // queryUm fora de transacao e somente leitura; INSERT ... RETURNING precisa de escrita.
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_PROJETO: number }>(
        `INSERT INTO PROJETOS (NOME, DESCRICAO, COR, ID_USUARIO_CRIADOR)
         VALUES (?, ?, ?, ?) RETURNING ID_PROJETO`,
        [truncar(dados.nome, 200)!, dados.descricao, truncar(dados.cor, 30), dados.idCriador],
      );
      return Number(linha!.ID_PROJETO);
    });
  }

  async atualizar(
    id: number,
    campos: Partial<{ NOME: string; DESCRICAO: string | null; COR: string | null; ARQUIVADO: boolean }>,
  ): Promise<void> {
    const chaves = Object.keys(campos);
    if (!chaves.length) return;
    const atribuicoes = chaves.map((c) => `${c} = ?`).join(', ');
    const valores = chaves.map((c) => (campos as Record<string, unknown>)[c] ?? null);
    await this.db.executar(`UPDATE PROJETOS SET ${atribuicoes} WHERE ID_PROJETO = ?`, [
      ...valores,
      id,
    ] as never[]);
  }

  /** Aceita transacao para o vinculo do roadmap gravar tudo junto. */
  async definirVinculo(
    id: number,
    idAsanaProjeto: number | null,
    tx?: TransacaoFirebird,
  ): Promise<void> {
    const sql = 'UPDATE PROJETOS SET ID_ASANA_PROJETO = ? WHERE ID_PROJETO = ?';
    if (tx) await tx.executar(sql, [idAsanaProjeto, id]);
    else await this.db.executar(sql, [idAsanaProjeto, id]);
  }
}
