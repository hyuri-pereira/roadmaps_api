import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UsuarioAutenticado } from '../../common/auth.types';
import { deDataAsana } from '../../common/utils';
import { RoadmapsService } from '../roadmaps/roadmaps.service';
import {
  AtualizarCardDto,
  CardDto,
  CriarCardDto,
  FiltroCardsDto,
  LinkReferenciaDto,
  ReferenciaDto,
  ReordenarCardsDto,
} from './cards.dto';
import { CardsRepository } from './cards.repository';
import { StorageService } from './storage.service';
import { mesclarComCorpoRemoto, montarCorpo, montarTitulo } from './card-corpo.util';

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    private readonly repo: CardsRepository,
    private readonly roadmaps: RoadmapsService,
    private readonly storage: StorageService,
  ) {}

  // -------------------------------------------------------------- leitura

  async listar(
    idRoadmap: number,
    filtro: FiltroCardsDto,
    usuario: UsuarioAutenticado,
  ): Promise<CardDto[]> {
    await this.roadmaps.assegurarLeitura(idRoadmap, usuario);
    const cards = await this.repo.listarDoRoadmap(idRoadmap, filtro);

    // Uma consulta por card seria N+1; para listas isso e aceitavel porque um
    // roadmap tem dezenas de cards, nao milhares. Se crescer, vira JOIN.
    return Promise.all(
      cards.map(async (card) => ({
        ...card,
        referencias: await this.repo.listarReferencias(card.id),
      })),
    );
  }

  async obter(id: number, usuario: UsuarioAutenticado): Promise<CardDto> {
    const card = await this.obterOuFalhar(id);
    await this.roadmaps.assegurarLeitura(card.idRoadmap, usuario);
    return { ...card, referencias: await this.repo.listarReferencias(id) };
  }

  private async obterOuFalhar(id: number): Promise<CardDto> {
    const card = await this.repo.porId(id);
    if (!card) throw new NotFoundException(`Card ${id} nao encontrado.`);
    return card;
  }

  // -------------------------------------------------------------- escrita

  async criar(
    idRoadmap: number,
    dto: CriarCardDto,
    usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    await this.roadmaps.assegurarEdicaoDeCard(idRoadmap, usuario);

    const contexto = await this.repo.contextoDoRoadmap(idRoadmap);
    if (!contexto) throw new NotFoundException(`Roadmap ${idRoadmap} nao encontrado.`);

    const prioridade = dto.prioridade ?? 3;
    const dataLimite = dto.dataLimite ? deDataAsana(dto.dataLimite) : null;
    if (dto.dataLimite && !dataLimite) {
      throw new BadRequestException('Data limite invalida. Use AAAA-MM-DD.');
    }

    const links = dto.links ?? [];
    const descricaoBase = dto.descricao ?? null;
    const descricao = montarCorpo(
      descricaoBase,
      links.map((l) => ({ rotulo: l.rotulo, url: l.url })),
    );

    const titulo =
      dto.titulo ??
      montarTitulo({
        projeto: contexto.projetoNome,
        prioridade,
        dataLimite,
        roadmap: contexto.roadmapTitulo,
      });

    const id = await this.repo.criar({
      idRoadmap,
      idCriador: usuario.id,
      titulo,
      tituloCustomizado: Boolean(dto.titulo),
      descricaoBase,
      descricao,
      dataLimite,
      prioridade,
      entrarNaSprint: dto.entrarNaSprint ?? false,
      ordem: await this.repo.proximaOrdem(idRoadmap),
      links: links.map((l) => ({ rotulo: l.rotulo ?? null, url: l.url })),
    });

    this.logger.log(
      `Card ${id} criado no roadmap ${idRoadmap} (destino: ` +
        `${dto.entrarNaSprint ? 'SPRINT/A fazer' : 'Backlog/Refino'}).`,
    );
    return this.obter(id, usuario);
  }

  async atualizar(
    id: number,
    dto: AtualizarCardDto,
    usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    const card = await this.obterOuFalhar(id);
    await this.roadmaps.assegurarEdicaoDeCard(card.idRoadmap, usuario);

    const campos: Record<string, unknown> = {};

    if (dto.prioridade !== undefined) campos.PRIORIDADE = dto.prioridade;
    if (dto.ordem !== undefined) campos.ORDEM = dto.ordem;
    if (dto.entrarNaSprint !== undefined) campos.ENTRAR_NA_SPRINT = dto.entrarNaSprint;

    // No card vinculado a etapa vem da secao do Asana (sync); so o local a
    // define aqui. Sem isso o card local nunca aparece em "Atencao".
    if (dto.etapaSprint !== undefined) {
      const contexto = await this.repo.contextoDoCard(id);
      if (contexto?.idEquipe !== null) {
        throw new BadRequestException(
          'A etapa de um card vinculado ao Asana segue a coluna da tarefa no Asana.',
        );
      }
      campos.ETAPA_SPRINT = dto.etapaSprint;
    }

    let dataLimite = card.dataLimite ? deDataAsana(card.dataLimite) : null;
    if (dto.dataLimite !== undefined) {
      dataLimite = dto.dataLimite ? deDataAsana(dto.dataLimite) : null;
      if (dto.dataLimite && !dataLimite) {
        throw new BadRequestException('Data limite invalida. Use AAAA-MM-DD.');
      }
      campos.DATA_LIMITE = dataLimite;
    }

    // Mexer no conteudo obriga a remontar o corpo preservando o que veio do
    // Asana acima do bloco de links.
    if (dto.descricao !== undefined) {
      const referencias = await this.repo.listarReferencias(id);
      campos.DESCRICAO_BASE = dto.descricao;
      campos.DESCRICAO = montarCorpo(
        dto.descricao,
        referencias.map((r) => ({ rotulo: r.rotulo, url: r.url })),
      );
    }

    if (dto.titulo !== undefined) {
      campos.TITULO = dto.titulo;
    } else if (dto.regenerarTitulo) {
      const contexto = await this.repo.contextoDoCard(id);
      const novo = montarTitulo({
        projeto: contexto!.projetoNome,
        prioridade: dto.prioridade ?? card.prioridade,
        dataLimite,
        roadmap: contexto!.roadmapTitulo,
      });
      campos.TITULO = novo;
      campos.TITULO_GERADO = novo;
    }

    if (!Object.keys(campos).length) return this.obter(id, usuario);

    // Alteracao local sempre vem do sistema, nunca do Asana.
    campos.ORIGEM_ULTIMA_ALTERACAO = 'SISTEMA';

    const resultado = await this.repo.atualizarESincronizar(id, campos, dto.revisaoEsperada);
    if (resultado === 'conflito') {
      throw new ConflictException(
        'Este card mudou desde que voce abriu (provavelmente alguem editou no Asana). ' +
          'Recarregue o card e refaca a alteracao.',
      );
    }

    return this.obter(id, usuario);
  }

  async definirConclusao(
    id: number,
    concluido: boolean,
    usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    const card = await this.obterOuFalhar(id);
    await this.roadmaps.assegurarEdicaoDeCard(card.idRoadmap, usuario);

    if (card.concluido === concluido) return this.obter(id, usuario);

    await this.repo.definirConclusao(id, concluido);
    this.logger.log(`Card ${id} marcado como ${concluido ? 'concluido' : 'pendente'}.`);
    return this.obter(id, usuario);
  }

  async excluir(id: number, usuario: UsuarioAutenticado): Promise<void> {
    const card = await this.obterOuFalhar(id);
    await this.roadmaps.assegurarEdicaoDeCard(card.idRoadmap, usuario);
    await this.repo.excluir(id, usuario.id);
    this.logger.log(`Card ${id} excluido; exclusao remota enfileirada.`);
  }

  async reordenar(
    idRoadmap: number,
    dto: ReordenarCardsDto,
    usuario: UsuarioAutenticado,
  ): Promise<CardDto[]> {
    await this.roadmaps.assegurarEdicaoDeCard(idRoadmap, usuario);
    const existentes = await this.repo.listarDoRoadmap(idRoadmap);
    const idsValidos = new Set(existentes.map((c) => c.id));

    for (const id of dto.ids) {
      if (!idsValidos.has(id)) {
        throw new BadRequestException(`O card ${id} nao pertence a este roadmap.`);
      }
    }

    await this.repo.reordenar(idRoadmap, dto.ids);
    return this.listar(idRoadmap, {}, usuario);
  }

  // ---------------------------------------------------------- referencias

  async listarReferencias(idCard: number, usuario: UsuarioAutenticado): Promise<ReferenciaDto[]> {
    const card = await this.obterOuFalhar(idCard);
    await this.roadmaps.assegurarLeitura(card.idRoadmap, usuario);
    return this.repo.listarReferencias(idCard);
  }

  async adicionarLink(
    idCard: number,
    dto: LinkReferenciaDto,
    usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    const card = await this.obterOuFalhar(idCard);
    await this.roadmaps.assegurarEdicaoDeCard(card.idRoadmap, usuario);

    // A trigger AIUD_REFERENCIA ja reenfileira o sync; aqui so precisamos
    // manter DESCRICAO coerente com o novo conjunto de links.
    await this.repo.adicionarReferencia({
      idCard,
      tipo: 'LINK',
      rotulo: dto.rotulo ?? null,
      url: dto.url,
      idUsuario: usuario.id,
    });

    await this.recomporCorpo(idCard);
    return this.repo.listarReferencias(idCard);
  }

  async anexarArquivo(
    idCard: number,
    arquivo: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    rotulo: string | undefined,
    usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    const card = await this.obterOuFalhar(idCard);
    await this.roadmaps.assegurarEdicaoDeCard(card.idRoadmap, usuario);

    const salvo = await this.storage.salvar(arquivo);

    // A URL depende do id da referencia, entao gravamos com um marcador e
    // atualizamos logo em seguida, tudo antes de recompor o corpo.
    const idReferencia = await this.repo.adicionarReferencia({
      idCard,
      tipo: 'ARQUIVO',
      rotulo: rotulo ?? salvo.nomeOriginal,
      url: 'pendente',
      objetoStorage: salvo.objeto,
      nomeArquivo: salvo.nomeOriginal,
      mimeType: salvo.mimeType,
      tamanhoBytes: salvo.tamanhoBytes,
      idUsuario: usuario.id,
    });

    await this.repo.atualizarUrlReferencia(idReferencia, this.storage.urlPublica(idReferencia));
    await this.recomporCorpo(idCard);
    return this.repo.listarReferencias(idCard);
  }

  async removerReferencia(
    idReferencia: number,
    usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    const referencia = await this.repo.referenciaPorId(idReferencia);
    if (!referencia) throw new NotFoundException(`Referencia ${idReferencia} nao encontrada.`);

    const card = await this.obterOuFalhar(referencia.idCard);
    await this.roadmaps.assegurarEdicaoDeCard(card.idRoadmap, usuario);

    await this.repo.removerReferencia(idReferencia);
    if (referencia.tipo === 'ARQUIVO') await this.storage.remover(referencia.objetoStorage);

    await this.recomporCorpo(referencia.idCard);
    return this.repo.listarReferencias(referencia.idCard);
  }

  /** Download autenticado: a URL e duravel, mas o acesso e checado sempre. */
  async prepararDownload(idReferencia: number, usuario: UsuarioAutenticado) {
    const referencia = await this.repo.referenciaPorId(idReferencia);
    if (!referencia) throw new NotFoundException('Arquivo nao encontrado.');
    if (referencia.tipo !== 'ARQUIVO' || !referencia.objetoStorage) {
      throw new BadRequestException('Esta referencia e um link, nao um arquivo.');
    }

    const card = await this.obterOuFalhar(referencia.idCard);
    await this.roadmaps.assegurarLeitura(card.idRoadmap, usuario);

    if (!this.storage.existe(referencia.objetoStorage)) {
      throw new NotFoundException(
        'O arquivo nao esta mais no armazenamento. O registro continua no card.',
      );
    }

    return {
      stream: this.storage.abrir(referencia.objetoStorage),
      nome: referencia.nomeArquivo ?? `arquivo-${idReferencia}`,
      mimeType: referencia.mimeType ?? 'application/octet-stream',
      tamanho: referencia.tamanhoBytes ?? undefined,
    };
  }

  /**
   * Regrava DESCRICAO a partir do ultimo corpo conhecido, trocando apenas o
   * bloco de links, e pede a sincronizacao.
   */
  private async recomporCorpo(idCard: number): Promise<void> {
    const card = await this.repo.porId(idCard);
    if (!card) return;

    const referencias = await this.repo.listarReferencias(idCard);
    const links = referencias.map((r) => ({ rotulo: r.rotulo, url: r.url }));

    // DESCRICAO_BASE guarda o texto sem o bloco gerenciado. Quando ela nao
    // existe (card espelhado do Asana), partimos do corpo remoto e tiramos o
    // bloco antigo, para nao apagar o que o time escreveu la.
    const corpo = card.descricaoBase
      ? montarCorpo(card.descricaoBase, links)
      : mesclarComCorpoRemoto(card.descricao, links);

    await this.repo.atualizarESincronizar(idCard, {
      DESCRICAO: corpo,
      ORIGEM_ULTIMA_ALTERACAO: 'SISTEMA',
    });
  }
}
