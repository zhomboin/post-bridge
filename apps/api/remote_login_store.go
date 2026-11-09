package bridge

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// 登录确认与等待任务恢复共用账号事务锁，重复观察同一结果不会重复恢复。
func (s *Store) ConfirmRemoteLogin(ctx context.Context, id string) error {
	if !remoteLoginID.MatchString(id) {
		return ErrInvalid
	}
	return s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		changed, err := tx.Exec(ctx, "UPDATE account SET status='connected',last_checked_at=$2,last_error='',remote_login_id=$1 WHERE id='csdn-main' AND remote_login_id<>$1", id, now)
		if err != nil {
			return err
		}
		if changed.RowsAffected() == 0 {
			return nil
		}
		rows, err := tx.Query(ctx, "SELECT record FROM jobs WHERE record->>'account_id'='csdn-main' AND record->>'status'='waiting_user' AND record->>'error_code'='needs_login' FOR UPDATE")
		if err != nil {
			return err
		}
		records := []*record{}
		for rows.Next() {
			var data []byte
			if err = rows.Scan(&data); err != nil {
				rows.Close()
				return err
			}
			var r record
			if err = json.Unmarshal(data, &r); err != nil {
				rows.Close()
				return err
			}
			records = append(records, &r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, r := range records {
			if r.CancelRequested || r.ManualResolved || r.LeaseToken != "" && r.LeaseExpiresAt.After(now) {
				continue
			}
			if err = r.action("resume", ActionInput{}, now, nil); err != nil {
				return err
			}
			r.ErrorCode, r.ErrorMessage = "", ""
			if err = save(ctx, tx, r); err != nil {
				return err
			}
			if err = appendLog(ctx, tx, r, "info", "平台登录已确认，等待任务已恢复", now); err != nil {
				return err
			}
		}
		return nil
	})
}
