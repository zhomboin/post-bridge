// 由 scripts/formatting-contract.mjs 生成，请修改 contracts/formatting-model.json。
export interface FormattingSnapshot {
  title: string;
  body: string;
  body_format: string;
  summary: string;
  tags: string[];
}
export interface FormattingBlock {
  id: string;
  kind: string;
  markdown: string;
  protected: boolean;
  text: string;
  locks: string[];
}
export interface FormattingIssue {
  code: string;
  field: string;
  message: string;
  blocking: boolean;
}
export interface FormattingCard {
  title: string;
  paragraphs: string[];
  code_refs: string[];
  source_block_ids: string[];
}
export interface FormattingAsset {
  id: string;
  sha256: string;
  width: number;
  height: number;
  url: string;
}
export interface FormattingOutput {
  title: string;
  summary: string;
  markdown: string;
  tags: string[];
  body: string;
  topics: string[];
  cover_title: string;
  cover_subtitle: string;
  cards: FormattingCard[];
  omissions: string[];
  issues: FormattingIssue[];
  assets: FormattingAsset[];
}
export interface FormattingSession {
  id: string;
  preparation_id: string;
  account_id: string;
  content_fingerprint: string;
  base_revision: number;
  revision: number;
  snapshot: FormattingSnapshot;
  platforms: string[];
  expires_at: string;
}
export interface FormattingJob {
  id: string;
  title: string;
  session_id: string;
  platform: string;
  operation: string;
  edit_request_id: string;
  edit_fingerprint: string;
  status: string;
  stage: string;
  revision: number;
  base_revision: number;
  request_id: string;
  result: FormattingOutput | null;
  error_code: string;
  created_at: string;
  updated_at: string;
  prompt_version: string;
  rules_version: string;
  template: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  confirmed: boolean;
  confirmation_fingerprint: string;
}
