// 由 scripts/formatting-contract.mjs 生成，请修改 contracts/formatting-model.json。
package bridge

type FormattingSnapshot struct {
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	BodyFormat string   `json:"body_format"`
	Summary    string   `json:"summary"`
	Tags       []string `json:"tags"`
}
type FormattingBlock struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Markdown  string   `json:"markdown"`
	Protected bool     `json:"protected"`
	Text      string   `json:"text"`
	Locks     []string `json:"locks"`
}
type FormattingIssue struct {
	Code     string `json:"code"`
	Field    string `json:"field"`
	Message  string `json:"message"`
	Blocking bool   `json:"blocking"`
}
type FormattingCard struct {
	Title          string   `json:"title"`
	Paragraphs     []string `json:"paragraphs"`
	CodeRefs       []string `json:"code_refs"`
	SourceBlockIds []string `json:"source_block_ids"`
}
type FormattingAsset struct {
	ID     string `json:"id"`
	Sha256 string `json:"sha256"`
	Width  int64  `json:"width"`
	Height int64  `json:"height"`
	URL    string `json:"url"`
}
type FormattingOutput struct {
	Title         string            `json:"title"`
	Summary       string            `json:"summary"`
	Markdown      string            `json:"markdown"`
	Tags          []string          `json:"tags"`
	Body          string            `json:"body"`
	Topics        []string          `json:"topics"`
	CoverTitle    string            `json:"cover_title"`
	CoverSubtitle string            `json:"cover_subtitle"`
	Cards         []FormattingCard  `json:"cards"`
	Omissions     []string          `json:"omissions"`
	Issues        []FormattingIssue `json:"issues"`
	Assets        []FormattingAsset `json:"assets"`
}
type FormattingSession struct {
	ID                 string             `json:"id"`
	PreparationID      string             `json:"preparation_id"`
	AccountID          string             `json:"account_id"`
	ContentFingerprint string             `json:"content_fingerprint"`
	BaseRevision       int64              `json:"base_revision"`
	Revision           int64              `json:"revision"`
	Snapshot           FormattingSnapshot `json:"snapshot"`
	Platforms          []string           `json:"platforms"`
	ExpiresAt          string             `json:"expires_at"`
}
type FormattingJob struct {
	ID                      string            `json:"id"`
	Title                   string            `json:"title"`
	SessionID               string            `json:"session_id"`
	Platform                string            `json:"platform"`
	Operation               string            `json:"operation"`
	EditRequestID           string            `json:"edit_request_id"`
	EditFingerprint         string            `json:"edit_fingerprint"`
	Status                  string            `json:"status"`
	Stage                   string            `json:"stage"`
	Revision                int64             `json:"revision"`
	BaseRevision            int64             `json:"base_revision"`
	RequestID               string            `json:"request_id"`
	Result                  *FormattingOutput `json:"result"`
	ErrorCode               string            `json:"error_code"`
	CreatedAt               string            `json:"created_at"`
	UpdatedAt               string            `json:"updated_at"`
	PromptVersion           string            `json:"prompt_version"`
	RulesVersion            string            `json:"rules_version"`
	Template                string            `json:"template"`
	Model                   string            `json:"model"`
	InputTokens             int64             `json:"input_tokens"`
	OutputTokens            int64             `json:"output_tokens"`
	Confirmed               bool              `json:"confirmed"`
	ConfirmationFingerprint string            `json:"confirmation_fingerprint"`
}
