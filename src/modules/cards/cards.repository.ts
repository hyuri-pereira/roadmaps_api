import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha, TransacaoFirebird } from '../../database/drivers/driver.interface';
import { paraBooleano, paraDataOuNulo, paraNumero, truncar } from '../../common/utils';
import { CardDto, FiltroCardsDto, ReferenciaDto } from './cards.dto';

const SELECT_CARD = `
  SELECT I.ID_ROADMAP_ITEM, I.ID_ROADMAP, I.TITULO, I.TITULO_GERADO,
         I.DESCRICAO_BASE, I.DESCRICAO, I.DATA_LIMITE, I.PRIORIDADE, I.ENTRAR_NA_SPRINT,
         I.CONCLUIDO, I.CONCLUSAO_SOLICITADA, I.CONCLUIDO_EM, I.ETAPA_SPRINT,
         E.NOME AS ETAPA_NOME, I.ASANA_TAREFA_GID, I.ASANA_PERMALINK,
         I.ASANA_RESPONSAVEL_NOME, I.SITUACAO_SINCRONIZACAO, I.ULTIMO_ERRO,
         I.ASANA_MODIFICADO_EM, I.SINCRONIZADO_EM, I.ORDEM, I.REVISAO,
         I.CRIADO_EM, I.ATUALIZADO_EM
    FROM ROADMAP_ITENS I
    LEFT JOIN ETAPAS_SPRINT E ON E.CODIGO = I.ETAPA_SPRINT
   WHERE I.EXCLUIDO_EM IS NULL
`;

export function mapearCard(l: Linha): CardDto {
  return {
    id: Number(l.ID_ROADMAP_ITEM),
    idRoadmap: Number(l.ID_ROADMAP),
    titulo: String(l.TITULO),
    tituloGerado: (l.TITULO_GERADO as string) ?? null,
    descricaoBase: (l.DESCRICAO_BASE as string) ?? null,
    descricao: (l.DESCRICAO as string) ?? null,
    dataLimite: comoDataIso(l.DATA_LIMITE),
    prioridade: paraNumero(l.PRIORIDADE),
    entrarNaSprint: paraBooleano(l.ENTRAR_NA_SPRINT),
    concluido: paraBooleano(l.CONCLUIDO),
    conclusaoSolicitada: paraBooleano(l.CONCLUSAO_SOLICITADA),
    concluidoEm: paraDataOuNulo(l.CONCLUIDO_EM),
    etapaSprint: (l.ETAPA_SPRINT as string) ?? null,
    etapaNome: (l.ETAPA_NOME as string) ?? null,
    asanaTarefaGid: (l.ASANA_TAREFA_GID as string) ?? null,
    asanaPermalink: (l.ASANA_PERMALINK as string) ?? null,
    asanaResponsavelNome: (l.ASANA_RESPONSAVEL_NOME as string) ?? null,
    situacaoSincronizacao: String(l.SITUACAO_SINCRONIZACAO).trim(),
    ultimoErro: (l.ULTIMO_ERRO as string) ?? null,
    asanaModificadoEm: paraDataOuNulo(l.ASANA_MODIFICADO_EM),
    sincronizadoEm: paraDataOuNulo(l.SINCRONIZADO_EM),
    ordem: paraNumero(l.ORDEM),
    revisao: paraNumero(l.REVISAO),
    criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
    atualizadoEm: paraDataOuNulo(l.ATUALIZADO_EM) as Date,
  };
}

function comoDataIso(valor: unknown): string | null {
  const data = paraDataOuNulo(valor);
  if (!data) return null;
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}

function mapearReferencia(l: Linha): ReferenciaDto {
  return {
    id: Number(l.ID_REFERENCIA),
    tipo: String(l.TIPO) as 'LINK' | 'ARQUIVO',
    rotulo: (l.ROTULO as string) ?? null,
    url: String(l.URL_REFERENCIA),
    nomeArquivo: (l.NOME_ARQUIVO as string) ?? null,
    mimeType: (l.MIME_TYPE as string) ?? null,
    tamanhoBytes: l.TAMANHO_BYTES ? Number(l.TAMANHO_BYTES) : null,
    ordem: paraNumero(l.ORDEM),
    criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
  };
}

@Injectable()
export class CardsRepository {
  constructor(private readonly db: FirebirdService) {}

  // ---------------------------------------------------------------- cards

  async porId(id: number): Promise<CardDto | null> {
    const linha = await this.db.queryUm(`${SELECT_CARD} AND I.ID_ROADMAP_ITEM = ?`, [id]);
    return linha ? mapearCard(linha) : null;
  }

  async porGid(gid: string): Promise<CardDto | null> {
    const linha = await this.db.queryUm(`${SELECT_CARD} AND I.ASANA_TAREFA_GID = ?`, [gid]);
    return linha ? mapearCard(linha) : null;
  }

  async listarDoRoadmap(idRoadmap: number, filtro: FiltroCardsDto = {}): Promise<CardDto[]> {
    const condicoes: string[] = ['I.ID_ROADMAP = ?'];
    const parametros: unknown[] = [idRoadmap];

    if (filtro.etapaSprint) {
      condicoes.push('I.ETAPA_SPRINT = ?');
      parametros.push(filtro.etapaSprint);
    }
    if (filtro.concluido !== undefined) {
      condicoes.push('I.CONCLUIDO = ?');
      parametros.push(filtro.concluido);
    }
    if (filtro.entrarNaSprint !== undefined) {
      condicoes.push('I.ENTRAR_NA_SPRINT = ?');
      parametros.push(filtro.entrarNaSprint);
    }
    if (filtro.situacaoSincronizacao) {
      condicoes.push('I.SITUACAO_SINCRONIZACAO = ?');
      parametros.push(filtro.situacaoSincronizacao);
    }

    const linhas = await this.db.query(
      `${SELECT_CARD} AND ${condicoes.join(' AND ')} ORDER BY I.ORDEM, I.ID_ROADMAP_ITEM`,
      parametros as never[],
    );
    return linhas.map(mapearCard);
  }

  /** Usado para telas de acompanhamento que cruzam varios roadmaps. */
  async listarPorEquipe(idEquipe: number, filtro: FiltroCardsDto = {}): Promise<CardDto[]> {
    const condicoes: string[] = ['R.ID_ASANA_EQUIPE = ?', 'R.EXCLUIDO_EM IS NULL'];
    const parametros: unknown[] = [idEquipe];

    if (filtro.etapaSprint) {
      condicoes.push('I.ETAPA_SPRINT = ?');
      parametros.push(filtro.etapaSprint);
    }
    if (filtro.concluido !== undefined) {
      condicoes.push('I.CONCLUIDO = ?');
      parametros.push(filtro.concluido);
    }

    const linhas = await this.db.query(
      `${SELECT_CARD.replace(
        'FROM ROADMAP_ITENS I',
        'FROM ROADMAP_ITENS I JOIN ROADMAPS R ON R.ID_ROADMAP = I.ID_ROADMAP',
      )} AND ${condicoes.join(' AND ')} ORDER BY I.ORDEM, I.ID_ROADMAP_ITEM`,
      parametros as never[],
    );
    return linhas.map(mapearCard);
  }

  async proximaOrdem(idRoadmap: number): Promise<number> {
    const linha = await this.db.queryUm<{ PROXIMA: number }>(
      `SELECT COALESCE(MAX(ORDEM), -1) + 1 AS PROXIMA FROM ROADMAP_ITENS
        WHERE ID_ROADMAP = ? AND EXCLUIDO_EM IS NULL`,
      [idRoadmap],
    );
    return Number(linha?.PROXIMA ?? 0);
  }

  /**
   * Cria o card e as referencias na MESMA transacao, como manda o contrato:
   * a trigger AI_ROADMAP_ITEM_FILA ja enfileira a criacao remota, e a
   * AIUD_REFERENCIA atualiza o corpo se vierem links junto.
   */
  async criar(dados: {
    idRoadmap: number;
    idCriador: number;
    titulo: string;
    tituloCustomizado: boolean;
    descricaoBase: string | null;
    descricao: string | null;
    dataLimite: Date | null;
    prioridade: number;
    entrarNaSprint: boolean;
    ordem: number;
    links: { rotulo?: string | null; url: string }[];
  }): Promise<number> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_ROADMAP_ITEM: number }>(
        `INSERT INTO ROADMAP_ITENS
           (ID_ROADMAP, ID_USUARIO_CRIADOR, TITULO, DESCRICAO_BASE, DESCRICAO,
            DATA_LIMITE, PRIORIDADE, ENTRAR_NA_SPRINT, ORDEM)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ID_ROADMAP_ITEM`,
        [
          dados.idRoadmap,
          dados.idCriador,
          truncar(dados.titulo, 1000)!,
          dados.descricaoBase,
          dados.descricao,
          dados.dataLimite,
          dados.prioridade,
          dados.entrarNaSprint,
          dados.ordem,
        ],
      );
      const id = Number(linha!.ID_ROADMAP_ITEM);

      // A trigger BI_CARD_TITULO gera o titulo padrao; se o gestor mandou um
      // titulo proprio, ele prevalece.
      if (dados.tituloCustomizado) {
        await tx.executar('UPDATE ROADMAP_ITENS SET TITULO = ? WHERE ID_ROADMAP_ITEM = ?', [
          truncar(dados.titulo, 1000)!,
          id,
        ]);
      }

      let ordem = 0;
      for (const link of dados.links) {
        await tx.executar(
          `INSERT INTO ITEM_REFERENCIAS
             (ID_ROADMAP_ITEM, TIPO, ROTULO, URL_REFERENCIA, ORDEM, ID_USUARIO)
           VALUES (?, 'LINK', ?, ?, ?, ?)`,
          [id, truncar(link.rotulo ?? null, 255), link.url, ordem++, dados.idCriador],
        );
      }

      return id;
    });
  }

  /**
   * Atualiza o card e pede a sincronizacao na mesma transacao.
   * Esse par e obrigatorio: sem SP_SOLICITAR_SYNC_ITEM a alteracao fica so
   * no banco e nunca chega ao Asana.
   */
  async atualizarESincronizar(
    id: number,
    campos: Record<string, unknown>,
    revisaoEsperada?: number,
  ): Promise<'ok' | 'conflito'> {
    const chaves = Object.keys(campos);
    return this.db.transacao(async (tx) => {
      if (revisaoEsperada !== undefined) {
        const atual = await tx.queryUm<{ REVISAO: number }>(
          'SELECT REVISAO FROM ROADMAP_ITENS WHERE ID_ROADMAP_ITEM = ? AND EXCLUIDO_EM IS NULL',
          [id],
        );
        if (!atual) return 'conflito';
        if (Number(atual.REVISAO) !== revisaoEsperada) return 'conflito';
      }

      if (chaves.length) {
        const atribuicoes = chaves.map((c) => `${c} = ?`).join(', ');
        const valores = chaves.map((c) => campos[c] ?? null);
        await tx.executar(
          `UPDATE ROADMAP_ITENS SET ${atribuicoes} WHERE ID_ROADMAP_ITEM = ?`,
          [...valores, id] as never[],
        );
      }

      await tx.executar('EXECUTE PROCEDURE SP_SOLICITAR_SYNC_ITEM(?)', [id]);
      return 'ok';
    });
  }

  /** Conclusao/reabertura. Nao passa pela fila de update de conteudo. */
  async definirConclusao(id: number, concluido: boolean): Promise<void> {
    await this.db.transacao(async (tx) => {
      const vinculado = await tx.queryUm<{ ID_ASANA_CONEXAO: number | null }>(
        `SELECT R.ID_ASANA_CONEXAO FROM ROADMAP_ITENS I
           JOIN ROADMAPS R ON R.ID_ROADMAP = I.ID_ROADMAP
          WHERE I.ID_ROADMAP_ITEM = ?`,
        [id],
      );
      // Card local conclui na hora: nao ha Asana para confirmar.
      const remoto = Boolean(vinculado?.ID_ASANA_CONEXAO);
      await tx.executar(
        'UPDATE ROADMAP_ITENS SET CONCLUIDO = ?, CONCLUSAO_SOLICITADA = ? WHERE ID_ROADMAP_ITEM = ?',
        [concluido, remoto && concluido, id],
      );
      if (remoto) await this.enfileirarConclusao(tx, id, concluido);
    });
  }

  private async enfileirarConclusao(
    tx: TransacaoFirebird,
    id: number,
    concluido: boolean,
  ): Promise<void> {
    const info = await tx.queryUm<{
      ID_ASANA_CONEXAO: number;
      ASANA_TAREFA_GID: string | null;
      REVISAO: number;
    }>(
      `SELECT R.ID_ASANA_CONEXAO, I.ASANA_TAREFA_GID, I.REVISAO
         FROM ROADMAP_ITENS I
         JOIN ROADMAPS R ON R.ID_ROADMAP = I.ID_ROADMAP
        WHERE I.ID_ROADMAP_ITEM = ?`,
      [id],
    );
    if (!info) return;

    const chave = `${concluido ? 'CONCLUIR' : 'REABRIR'}_TAREFA:${id}:${info.REVISAO}`;
    const existe = await tx.queryUm<{ TOTAL: number }>(
      'SELECT COUNT(*) AS TOTAL FROM INTEGRACAO_FILA WHERE CHAVE_IDEMPOTENCIA = ?',
      [chave],
    );
    if (Number(existe?.TOTAL ?? 0) > 0) return;

    // Reabrir tambem e um CONCLUIR_TAREFA: o worker le o estado atual do card
    // e manda completed=true/false conforme o banco.
    await tx.executar(
      `INSERT INTO INTEGRACAO_FILA
         (ID_ASANA_CONEXAO, TIPO_OPERACAO, TIPO_ENTIDADE_LOCAL, ID_ENTIDADE_LOCAL,
          RECURSO_GID, CHAVE_IDEMPOTENCIA, PRIORIDADE_FILA)
       VALUES (?, 'CONCLUIR_TAREFA', 'ROADMAP_ITEM', ?, ?, ?, 2)`,
      [info.ID_ASANA_CONEXAO, id, info.ASANA_TAREFA_GID, chave],
    );
  }

  async excluir(id: number, idUsuario: number): Promise<void> {
    await this.db.transacao(async (tx) => {
      await tx.executar('EXECUTE PROCEDURE SP_EXCLUIR_ITEM(?)', [id]);
      await tx.executar(
        `INSERT INTO AUDITORIA_EVENTOS
           (ID_USUARIO, TIPO_ENTIDADE, ID_ENTIDADE, ACAO, ORIGEM, RESUMO)
         VALUES (?, 'ROADMAP_ITEM', ?, 'EXCLUIR', 'USUARIO', 'Card excluido pelo gestor')`,
        [idUsuario, id],
      );
    });
  }

  async reordenar(idRoadmap: number, ids: number[]): Promise<void> {
    await this.db.transacao(async (tx) => {
      for (let i = 0; i < ids.length; i += 1) {
        await tx.executar(
          'UPDATE ROADMAP_ITENS SET ORDEM = ? WHERE ID_ROADMAP_ITEM = ? AND ID_ROADMAP = ?',
          [i, ids[i], idRoadmap],
        );
      }
    });
  }

  // ---------------------------------------------------------- referencias

  async listarReferencias(idCard: number): Promise<ReferenciaDto[]> {
    const linhas = await this.db.query(
      `SELECT ID_REFERENCIA, TIPO, ROTULO, URL_REFERENCIA, NOME_ARQUIVO, MIME_TYPE,
              TAMANHO_BYTES, ORDEM, CRIADO_EM
         FROM ITEM_REFERENCIAS WHERE ID_ROADMAP_ITEM = ? ORDER BY ORDEM, ID_REFERENCIA`,
      [idCard],
    );
    return linhas.map(mapearReferencia);
  }

  async adicionarReferencia(dados: {
    idCard: number;
    tipo: 'LINK' | 'ARQUIVO';
    rotulo?: string | null;
    url: string;
    objetoStorage?: string | null;
    nomeArquivo?: string | null;
    mimeType?: string | null;
    tamanhoBytes?: number | null;
    idUsuario: number;
  }): Promise<number> {
    return this.db.transacao(async (tx) => {
      const ordem = await tx.queryUm<{ PROXIMA: number }>(
        'SELECT COALESCE(MAX(ORDEM), -1) + 1 AS PROXIMA FROM ITEM_REFERENCIAS WHERE ID_ROADMAP_ITEM = ?',
        [dados.idCard],
      );
      const linha = await tx.queryUm<{ ID_REFERENCIA: number }>(
        `INSERT INTO ITEM_REFERENCIAS
           (ID_ROADMAP_ITEM, TIPO, ROTULO, URL_REFERENCIA, OBJETO_STORAGE, NOME_ARQUIVO,
            MIME_TYPE, TAMANHO_BYTES, ORDEM, ID_USUARIO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ID_REFERENCIA`,
        [
          dados.idCard,
          dados.tipo,
          truncar(dados.rotulo ?? null, 255),
          dados.url,
          truncar(dados.objetoStorage ?? null, 1000),
          truncar(dados.nomeArquivo ?? null, 255),
          truncar(dados.mimeType ?? null, 150),
          dados.tamanhoBytes ?? null,
          Number(ordem?.PROXIMA ?? 0),
          dados.idUsuario,
        ],
      );
      return Number(linha!.ID_REFERENCIA);
    });
  }

  async referenciaPorId(id: number): Promise<
    | (ReferenciaDto & { idCard: number; objetoStorage: string | null })
    | null
  > {
    const linha = await this.db.queryUm(
      `SELECT ID_REFERENCIA, ID_ROADMAP_ITEM, TIPO, ROTULO, URL_REFERENCIA, OBJETO_STORAGE,
              NOME_ARQUIVO, MIME_TYPE, TAMANHO_BYTES, ORDEM, CRIADO_EM
         FROM ITEM_REFERENCIAS WHERE ID_REFERENCIA = ?`,
      [id],
    );
    if (!linha) return null;
    return {
      ...mapearReferencia(linha),
      idCard: Number(linha.ID_ROADMAP_ITEM),
      objetoStorage: (linha.OBJETO_STORAGE as string) ?? null,
    };
  }

  async removerReferencia(id: number): Promise<void> {
    await this.db.executar('DELETE FROM ITEM_REFERENCIAS WHERE ID_REFERENCIA = ?', [id]);
  }

  /** Atualiza a URL depois que o arquivo ganha o id definitivo. */
  async atualizarUrlReferencia(id: number, url: string): Promise<void> {
    await this.db.executar('UPDATE ITEM_REFERENCIAS SET URL_REFERENCIA = ? WHERE ID_REFERENCIA = ?', [
      url,
      id,
    ]);
  }

  /** Contexto necessario para montar titulo e corpo do card. */
  async contextoDoCard(idCard: number): Promise<{
    idRoadmap: number;
    roadmapTitulo: string;
    projetoNome: string;
    /** null = roadmap local */
    idEquipe: number | null;
    idGestor: number;
  } | null> {
    const linha = await this.db.queryUm(
      `SELECT R.ID_ROADMAP, R.TITULO AS ROADMAP_TITULO, P.NOME AS PROJETO_NOME,
              R.ID_ASANA_EQUIPE, R.ID_USUARIO_GESTOR
         FROM ROADMAP_ITENS I
         JOIN ROADMAPS R ON R.ID_ROADMAP = I.ID_ROADMAP
         JOIN PROJETOS P ON P.ID_PROJETO = R.ID_PROJETO
        WHERE I.ID_ROADMAP_ITEM = ?`,
      [idCard],
    );
    if (!linha) return null;
    return {
      idRoadmap: Number(linha.ID_ROADMAP),
      roadmapTitulo: String(linha.ROADMAP_TITULO),
      projetoNome: String(linha.PROJETO_NOME),
      idEquipe: linha.ID_ASANA_EQUIPE ? Number(linha.ID_ASANA_EQUIPE) : null,
      idGestor: Number(linha.ID_USUARIO_GESTOR),
    };
  }

  async contextoDoRoadmap(idRoadmap: number): Promise<{
    roadmapTitulo: string;
    projetoNome: string;
  } | null> {
    const linha = await this.db.queryUm(
      `SELECT R.TITULO AS ROADMAP_TITULO, P.NOME AS PROJETO_NOME
         FROM ROADMAPS R
         JOIN PROJETOS P ON P.ID_PROJETO = R.ID_PROJETO
        WHERE R.ID_ROADMAP = ?`,
      [idRoadmap],
    );
    if (!linha) return null;
    return {
      roadmapTitulo: String(linha.ROADMAP_TITULO),
      projetoNome: String(linha.PROJETO_NOME),
    };
  }
}
