import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha } from '../../database/drivers/driver.interface';
import { UsuarioAutenticado } from '../../common/auth.types';
import { paraBooleano, paraDataOuNulo, paraNumero } from '../../common/utils';
import { EquipesRepository } from '../equipes/equipes.repository';
import { filtroVisibilidade } from '../roadmaps/roadmaps.repository';
import {
  CardAcompanhamentoDto,
  ColunaQuadroDto,
  VisaoGeralDto,
  VisaoProjetoDto,
} from './dashboard.dto';

/**
 * Visoes gerenciais. Leem as views do banco (VW_ROADMAP_GERAL,
 * VW_ROADMAP_PROGRESSO, VW_CARDS_ACOMPANHAMENTO), de modo que o percentual
 * mostrado aqui e exatamente o mesmo calculado pelo Firebird.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: FirebirdService,
    private readonly equipes: EquipesRepository,
  ) {}

  /** Visao geral de todos os projetos. */
  async geral(usuario: UsuarioAutenticado): Promise<VisaoGeralDto> {
    const visivel = await this.visibilidade(usuario);

    // ADMIN usa a view pronta; os demais precisam do recorte por equipe.
    if (visivel === null) {
      const l = await this.db.queryUm('SELECT * FROM VW_ROADMAP_GERAL');
      return mapearGeral(l ?? {});
    }

    const filtro = filtroVisibilidade('V', visivel);
    const l = await this.db.queryUm(
      `SELECT COUNT(V.ID_ROADMAP) AS TOTAL_ROADMAPS,
              SUM(CASE WHEN V.SITUACAO = 'CONCLUIDO' THEN 1 ELSE 0 END) AS ROADMAPS_CONCLUIDOS,
              SUM(CASE WHEN V.SITUACAO IN ('PLANEJADO','EM_ANDAMENTO','CONCLUSAO_PENDENTE')
                       THEN 1 ELSE 0 END) AS ROADMAPS_ATIVOS,
              COALESCE(SUM(V.TOTAL_CARDS), 0) AS TOTAL_CARDS,
              COALESCE(SUM(V.CARDS_CONCLUIDOS), 0) AS CARDS_CONCLUIDOS,
              CAST(CASE WHEN COALESCE(SUM(V.TOTAL_CARDS), 0) = 0 THEN 0
                        ELSE 100.00 * SUM(V.CARDS_CONCLUIDOS) / SUM(V.TOTAL_CARDS) END
                   AS NUMERIC(6,2)) AS PERCENTUAL_GERAL
         FROM VW_ROADMAP_PROGRESSO V
        WHERE ${filtro.sql}`,
      filtro.params as never[],
    );
    return mapearGeral(l ?? {});
  }

  /**
   * Roadmaps agrupados pelo projeto LOCAL (vinculado ao Asana ou nao). O
   * recorte de visibilidade e por roadmap, entao a soma e feita aqui em vez
   * de numa view por projeto.
   */
  async porProjeto(usuario: UsuarioAutenticado): Promise<VisaoProjetoDto[]> {
    const visivel = await this.visibilidade(usuario);
    const filtro = visivel ? filtroVisibilidade('V', visivel) : null;

    const linhas = await this.db.query(
      `SELECT PL.ID_PROJETO, PL.NOME AS PROJETO, AP.ASANA_GID, AP.ID_ASANA_EQUIPE,
              COUNT(V.ID_ROADMAP) AS TOTAL_ROADMAPS,
              SUM(CASE WHEN V.SITUACAO = 'CONCLUIDO' THEN 1 ELSE 0 END) AS ROADMAPS_CONCLUIDOS,
              SUM(CASE WHEN V.SITUACAO IN ('PLANEJADO','EM_ANDAMENTO','CONCLUSAO_PENDENTE')
                       THEN 1 ELSE 0 END) AS ROADMAPS_ATIVOS,
              COALESCE(SUM(V.TOTAL_CARDS), 0) AS TOTAL_CARDS,
              COALESCE(SUM(V.CARDS_CONCLUIDOS), 0) AS CARDS_CONCLUIDOS,
              CAST(CASE WHEN COALESCE(SUM(V.TOTAL_CARDS), 0) = 0 THEN 0
                        ELSE 100.00 * SUM(V.CARDS_CONCLUIDOS) / SUM(V.TOTAL_CARDS) END
                   AS NUMERIC(6,2)) AS PERCENTUAL_GERAL
         FROM VW_ROADMAP_PROGRESSO V
         JOIN ROADMAPS R ON R.ID_ROADMAP = V.ID_ROADMAP
         JOIN PROJETOS PL ON PL.ID_PROJETO = R.ID_PROJETO
         LEFT JOIN ASANA_PROJETOS AP ON AP.ID_ASANA_PROJETO = PL.ID_ASANA_PROJETO
        ${filtro ? `WHERE ${filtro.sql}` : ''}
        GROUP BY PL.ID_PROJETO, PL.NOME, AP.ASANA_GID, AP.ID_ASANA_EQUIPE
        ORDER BY PL.NOME`,
      (filtro?.params ?? []) as never[],
    );
    return linhas.map((l) => ({
      idProjeto: Number(l.ID_PROJETO),
      asanaGid: (l.ASANA_GID as string) ?? null,
      projeto: String(l.PROJETO),
      idEquipe: l.ID_ASANA_EQUIPE ? Number(l.ID_ASANA_EQUIPE) : null,
      totalRoadmaps: paraNumero(l.TOTAL_ROADMAPS),
      roadmapsConcluidos: paraNumero(l.ROADMAPS_CONCLUIDOS),
      roadmapsAtivos: paraNumero(l.ROADMAPS_ATIVOS),
      totalCards: paraNumero(l.TOTAL_CARDS),
      cardsConcluidos: paraNumero(l.CARDS_CONCLUIDOS),
      percentualGeral: paraNumero(l.PERCENTUAL_GERAL),
    }));
  }

  /** Acompanhamento dos cards, agrupados pela coluna do quadro SPRINT. */
  async quadro(usuario: UsuarioAutenticado, idRoadmap?: number): Promise<ColunaQuadroDto[]> {
    const visivel = await this.visibilidade(usuario);
    const condicoes: string[] = [];
    const parametros: unknown[] = [];

    if (idRoadmap) {
      condicoes.push('ID_ROADMAP = ?');
      parametros.push(idRoadmap);
    }
    if (visivel !== null) {
      const filtro = filtroVisibilidade('', visivel);
      condicoes.push(filtro.sql);
      parametros.push(...filtro.params);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const linhas = await this.db.query(
      `SELECT * FROM VW_CARDS_ACOMPANHAMENTO ${where}
        ORDER BY COALESCE(ETAPA_ORDEM, 99), PRIORIDADE, DATA_LIMITE`,
      parametros as never[],
    );

    const etapas = await this.db.query<{ CODIGO: string; NOME: string; ORDEM: number }>(
      'SELECT CODIGO, NOME, ORDEM FROM ETAPAS_SPRINT ORDER BY ORDEM',
    );

    const colunas = new Map<string, ColunaQuadroDto>();
    for (const etapa of etapas) {
      colunas.set(String(etapa.CODIGO), {
        codigo: String(etapa.CODIGO),
        nome: String(etapa.NOME),
        ordem: Number(etapa.ORDEM),
        total: 0,
        cards: [],
      });
    }
    // Cards que ainda nao entraram no quadro SPRINT (estao no Backlog).
    colunas.set('SEM_ETAPA', {
      codigo: 'SEM_ETAPA',
      nome: 'Fora do quadro SPRINT',
      ordem: 99,
      total: 0,
      cards: [],
    });

    for (const linha of linhas) {
      const card = mapearCardAcompanhamento(linha);
      const chave = card.etapa ?? 'SEM_ETAPA';
      const coluna = colunas.get(chave) ?? colunas.get('SEM_ETAPA')!;
      coluna.cards.push(card);
      coluna.total += 1;
    }

    return [...colunas.values()].sort((a, b) => a.ordem - b.ordem);
  }

  /**
   * Cards que exigem atencao: atrasados, parados, com pendencia externa ou
   * com erro. Todos ainda nao concluidos.
   */
  async atencao(usuario: UsuarioAutenticado): Promise<CardAcompanhamentoDto[]> {
    const visivel = await this.visibilidade(usuario);
    const condicoes = [
      "(DATA_LIMITE < CURRENT_DATE " +
        "OR ETAPA_SPRINT IN ('PARADO', 'PENDENCIA_EXTERNA') " +
        "OR SITUACAO_SINCRONIZACAO IN ('ERRO', 'CONFLITO'))",
      'CONCLUIDO = FALSE',
    ];
    const parametros: unknown[] = [];

    if (visivel !== null) {
      const filtro = filtroVisibilidade('', visivel);
      condicoes.push(filtro.sql);
      parametros.push(...filtro.params);
    }

    const linhas = await this.db.query(
      `SELECT * FROM VW_CARDS_ACOMPANHAMENTO
        WHERE ${condicoes.join(' AND ')}
        ORDER BY DATA_LIMITE NULLS LAST, PRIORIDADE`,
      parametros as never[],
    );
    return linhas.map(mapearCardAcompanhamento);
  }

  /**
   * null = ADMIN (ve tudo). Senao: equipes do Asana em que participa e os
   * roadmaps locais dos quais e gestor (mesma regra da lista de roadmaps).
   */
  private async visibilidade(
    usuario: UsuarioAutenticado,
  ): Promise<{ equipes: number[]; idUsuario: number } | null> {
    if (usuario.perfil === 'ADMIN') return null;
    const equipes = await this.equipes.listarDoUsuario(usuario.id);
    return { equipes: equipes.map((e) => e.id), idUsuario: usuario.id };
  }
}

function mapearGeral(l: Linha): VisaoGeralDto {
  return {
    totalRoadmaps: paraNumero(l.TOTAL_ROADMAPS),
    roadmapsConcluidos: paraNumero(l.ROADMAPS_CONCLUIDOS),
    roadmapsAtivos: paraNumero(l.ROADMAPS_ATIVOS),
    totalCards: paraNumero(l.TOTAL_CARDS),
    cardsConcluidos: paraNumero(l.CARDS_CONCLUIDOS),
    percentualGeral: paraNumero(l.PERCENTUAL_GERAL),
  };
}

function mapearCardAcompanhamento(l: Linha): CardAcompanhamentoDto {
  const data = paraDataOuNulo(l.DATA_LIMITE);
  return {
    id: Number(l.ID_ROADMAP_ITEM),
    idRoadmap: Number(l.ID_ROADMAP),
    roadmap: String(l.ROADMAP),
    titulo: String(l.TITULO),
    dataLimite: data
      ? `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(
          data.getDate(),
        ).padStart(2, '0')}`
      : null,
    prioridade: paraNumero(l.PRIORIDADE),
    entrarNaSprint: paraBooleano(l.ENTRAR_NA_SPRINT),
    concluido: paraBooleano(l.CONCLUIDO),
    etapa: (l.ETAPA_SPRINT as string) ?? null,
    etapaNome: (l.ETAPA_NOME as string) ?? null,
    etapaOrdem: l.ETAPA_ORDEM ? Number(l.ETAPA_ORDEM) : null,
    responsavel: (l.ASANA_RESPONSAVEL_NOME as string) ?? null,
    permalink: (l.ASANA_PERMALINK as string) ?? null,
    situacaoSincronizacao: String(l.SITUACAO_SINCRONIZACAO).trim(),
    sincronizadoEm: paraDataOuNulo(l.SINCRONIZADO_EM),
  };
}
