package bridge

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// 主记录和修订都包含完整本地稿。保存时按所有者串行核对实际大小。
func checkWechatResultStorage(ctx context.Context, tx pgx.Tx, job FormattingJob, output FormattingOutput) error {
	body, err := json.Marshal(output)
	if err != nil {
		return err
	}
	var stored int64
	err = tx.QueryRow(ctx, `SELECT
		COALESCE((SELECT sum(octet_length((record->'result')::text)) FROM formatting_jobs
			WHERE owner_user_id=$1 AND id<>$2),0)
		+ COALESCE((SELECT sum(octet_length(record::text)) FROM formatting_revisions WHERE owner_user_id=$1),0)`,
		scopeOf(ctx).UserID, job.ID).Scan(&stored)
	if err != nil {
		return err
	}
	// jsonb 的序列化与传入 JSON 略有不同，统一按数据库文本字节计算。
	var length int64
	if err = tx.QueryRow(ctx, "SELECT octet_length(($1::jsonb)::text)", body).Scan(&length); err != nil {
		return err
	}
	if stored+2*length > 64<<20 {
		return formattingError("formatting_quota")
	}
	return nil
}
