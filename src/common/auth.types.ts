export type Perfil = 'ADMIN' | 'GESTOR' | 'LEITOR';

/** Identidade resolvida pelo JwtAuthGuard e anexada em request.user. */
export interface UsuarioAutenticado {
  id: number;
  nome: string;
  email: string;
  perfil: Perfil;
}

export interface PayloadJwt {
  sub: number;
  email: string;
  nome: string;
  perfil: Perfil;
  iss?: string;
  iat?: number;
  exp?: number;
}
