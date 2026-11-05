export type IntegrationClient = {
  id: string; name: string; source_id: string; environment: string; service_id: string; status: string;
  scopes: string[]; accounts: string[]; operations: string[]; grant_version: number; expires_at: string;
  rate_limit_per_minute: number;
};
export type Registration = Partial<IntegrationClient> & { id: string; name: string; status: string; created_at: string };
export type IssuedSecret = { client_id?: string; key_id?: string; client_secret?: string; invitation_id?: string; invitation_token?: string; expires_at?: string };
export type CSDNPublishOptions = {
  tags: string[]; summary: string; categories: string[]; article_type: string; creation_declaration: string;
  visibility: string; template: string; cover_image_url: string;
};
export type PlatformDraft = { id: string; platform: string; account_id: string; operation: string; title: string; markdown: string; revision: number; publish_options?: CSDNPublishOptions };
export type Preparation = {
  id: string; request_id: string; source_id: string; client_id: string; article_id: string; source_version: number;
  state_seq: number; content_fingerprint: string; revision: number; confirmed: boolean; status: string;
  expires_at: string; created_at: string; confirmation_fingerprint?: string; draft_revision_ids?: string[]; preview_image_urls?: string[];
  snapshot: { title: string; summary: string; body: string; body_format: string; tags: string[]; cover_image_url?: string }; drafts: PlatformDraft[];
};
export const integrationStatuses: Record<string, string> = {
  in_progress: '处理中', needs_attention: '需要处理', completed: '处理完成', prepared: '待确认', confirmed: '已确认', submitted: '已提交', revoked: '已撤销', expired: '已过期',
  active: '已启用', suspended: '已暂停', pending: '待审批', invitation_pending: '待使用', pending_activation: '待激活', approved: '已批准', rejected: '已拒绝', used: '已使用', consumed: '已使用',
};
export const integrationScopes = [
  ['targets:read', '读取目标'], ['preparations:write', '创建平台稿'], ['preparations:read', '读取平台稿'],
  ['distributions:write', '提交草稿任务'], ['distributions:read', '读取任务状态'], ['source-events:write', '接收来源事件'],
] as const;

export type IntegrationDistribution = {
  id: string; source_id: string; article_id: string; preparation_id?: string; source_version?: number;
  confirmation_fingerprint: string; created_at: string; status: string; resume_allowed: boolean;
  children: { id: string; platform: string; account_id: string; operation: string; status: string; external_status: string; outcome?: string; last_confirmed_at?: string; remote_url?: string; error_code?: string; error_message?: string; detail_url?: string }[];
};
