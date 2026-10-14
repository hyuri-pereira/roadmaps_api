/** Formas do Asana que a aplicacao realmente consome. */

export interface AsanaRecurso {
  gid: string;
  resource_type?: string;
  name?: string;
}

export interface AsanaUsuario extends AsanaRecurso {
  email?: string;
  photo?: { image_60x60?: string } | null;
  workspaces?: AsanaRecurso[];
}

export interface AsanaWorkspace extends AsanaRecurso {
  is_organization?: boolean;
}

export interface AsanaEquipe extends AsanaRecurso {
  organization?: AsanaRecurso;
}

export interface AsanaProjeto extends AsanaRecurso {
  notes?: string;
  color?: string | null;
  default_view?: string;
  archived?: boolean;
  completed?: boolean;
  permalink_url?: string;
  modified_at?: string;
  team?: AsanaRecurso | null;
  workspace?: AsanaRecurso;
}

export interface AsanaSecao extends AsanaRecurso {
  project?: AsanaRecurso;
  created_at?: string;
}

export interface AsanaMembership {
  project?: AsanaRecurso;
  section?: AsanaRecurso | null;
}

export interface AsanaTarefa extends AsanaRecurso {
  notes?: string;
  html_notes?: string;
  completed?: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  modified_at?: string;
  permalink_url?: string;
  assignee?: AsanaRecurso | null;
  projects?: AsanaRecurso[];
  memberships?: AsanaMembership[];
}

export interface AsanaWebhook extends AsanaRecurso {
  active?: boolean;
  resource?: AsanaRecurso;
  target?: string;
  last_success_at?: string | null;
}

export interface AsanaEvento {
  user?: AsanaRecurso | null;
  created_at?: string;
  action?: string;
  resource?: AsanaRecurso & { resource_subtype?: string };
  parent?: AsanaRecurso | null;
  change?: { field?: string; action?: string; new_value?: unknown };
}

/** Token devolvido pelo fluxo OAuth do Asana. */
export interface AsanaTokenOAuth {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  data?: AsanaUsuario;
}

export const CAMPOS_PROJETO =
  'gid,name,notes,color,default_view,archived,completed,permalink_url,modified_at,team,team.name,workspace,workspace.name';

export const CAMPOS_SECAO = 'gid,name,created_at,project,project.name';

export const CAMPOS_TAREFA =
  'gid,name,notes,completed,completed_at,due_on,modified_at,permalink_url,' +
  'assignee,assignee.name,projects,projects.name,memberships,memberships.project,' +
  'memberships.project.name,memberships.section,memberships.section.name';
