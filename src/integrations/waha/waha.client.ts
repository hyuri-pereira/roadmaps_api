import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export class ErroWaha extends HttpException {
  constructor(
    mensagem: string,
    readonly statusWaha: number,
    readonly retryAfterSegundos?: number,
  ) {
    super(mensagem, statusWaha >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_REQUEST);
  }

  get temporario(): boolean {
    return this.statusWaha === 0 || this.statusWaha === 429 || this.statusWaha >= 500;
  }
}

/** Estados que o WAHA reporta para uma sessao. */
export type SituacaoSessaoWaha =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'WORKING'
  | 'FAILED';

export interface StatusSessao {
  nome: string;
  situacao: SituacaoSessaoWaha;
  /** Numero conectado, em digitos (ex.: 5511912345678). */
  numero?: string | null;
  chatIdProprio?: string | null;
  nomeExibicao?: string | null;
}

/**
 * Cliente do WAHA (WhatsApp HTTP API).
 *
 * Os caminhos seguem a API documentada do WAHA. Versoes diferentes do WAHA
 * mudaram alguns endpoints ao longo do tempo; se a sua instancia responder
 * 404 aqui, confira a documentacao da versao instalada e ajuste os caminhos
 * neste arquivo - e o unico lugar que fala com o WAHA.
 */
export class WahaClient {
  private readonly logger = new Logger(WahaClient.name);
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string, timeoutMs: number) {
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ''),
      timeout: timeoutMs,
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      validateStatus: () => true,
    });
  }

  async iniciarSessao(nome: string, webhookUrl?: string): Promise<void> {
    const corpo: Record<string, unknown> = { name: nome };
    if (webhookUrl) {
      corpo.config = {
        webhooks: [{ url: webhookUrl, events: ['session.status'] }],
      };
    }

    const resposta = await this.http.post('/api/sessions/start', corpo);
    // 422 costuma significar "sessao ja existe/iniciada", o que nao e erro.
    if (resposta.status >= 400 && resposta.status !== 422) {
      throw this.erro(resposta, `iniciar a sessao ${nome}`);
    }
  }

  async pararSessao(nome: string): Promise<void> {
    const resposta = await this.http.post('/api/sessions/stop', { name: nome });
    if (resposta.status >= 400 && resposta.status !== 404) {
      throw this.erro(resposta, `parar a sessao ${nome}`);
    }
  }

  /** Encerra a conta conectada: invalida a verificacao do numero. */
  async desconectar(nome: string): Promise<void> {
    const resposta = await this.http.post('/api/sessions/logout', { name: nome });
    if (resposta.status >= 400 && resposta.status !== 404) {
      throw this.erro(resposta, `desconectar a sessao ${nome}`);
    }
  }

  async status(nome: string): Promise<StatusSessao | null> {
    const resposta = await this.http.get(`/api/sessions/${encodeURIComponent(nome)}`);
    if (resposta.status === 404) return null;
    if (resposta.status >= 400) throw this.erro(resposta, `consultar a sessao ${nome}`);

    const dados = resposta.data ?? {};
    const identificador: string | undefined = dados?.me?.id;

    return {
      nome: dados?.name ?? nome,
      situacao: (dados?.status ?? 'STOPPED') as SituacaoSessaoWaha,
      numero: identificador ? identificador.replace(/\D/g, '') : null,
      chatIdProprio: identificador ?? null,
      nomeExibicao: dados?.me?.pushName ?? null,
    };
  }

  /**
   * QR code da sessao, em base64.
   *
   * O QR NUNCA e persistido: e buscado sob demanda e exibido apenas ao
   * gestor dono da sessao. Quem escaneia conecta o proprio WhatsApp; nenhuma
   * mensagem e enviada nesse momento.
   */
  async qrCodeBase64(nome: string): Promise<{ mimeType: string; base64: string }> {
    const resposta = await this.http.get(`/api/${encodeURIComponent(nome)}/auth/qr`, {
      params: { format: 'image' },
      responseType: 'arraybuffer',
      headers: { Accept: 'image/png' },
    });

    if (resposta.status >= 400) {
      throw new ErroWaha(
        `Nao foi possivel obter o QR code da sessao ${nome}. ` +
          'Verifique se a sessao esta em SCAN_QR_CODE.',
        resposta.status,
      );
    }

    const tipo = String(resposta.headers?.['content-type'] ?? 'image/png');
    return {
      mimeType: tipo.split(';')[0],
      base64: Buffer.from(resposta.data).toString('base64'),
    };
  }

  async enviarTexto(
    sessao: string,
    chatId: string,
    texto: string,
  ): Promise<{ id: string | null }> {
    const resposta = await this.http.post('/api/sendText', {
      session: sessao,
      chatId,
      text: texto,
    });

    if (resposta.status >= 400) throw this.erro(resposta, 'enviar a mensagem');

    return { id: resposta.data?.id ?? resposta.data?._data?.id?._serialized ?? null };
  }

  private erro(resposta: { status: number; data?: any; headers?: any }, acao: string): ErroWaha {
    const detalhe =
      resposta.data?.message ?? resposta.data?.error ?? `HTTP ${resposta.status}`;
    const retryAfter = Number(resposta.headers?.['retry-after']);
    return new ErroWaha(
      `Falha ao ${acao} no WAHA: ${detalhe}`,
      resposta.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
}
