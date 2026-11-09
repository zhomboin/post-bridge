package bridge

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 用户范围仅由认证入口建立；每次数据库操作在独立事务中设置，禁止连接池串用身份。
type tenantScope struct {
	UserID, AccountID, CallerID string
	ConnectionVersion           int64
}
type tenantScopeKey struct{}

func scopeOf(ctx context.Context) tenantScope {
	v, _ := ctx.Value(tenantScopeKey{}).(tenantScope)
	return v
}
func scoped(ctx context.Context, scope tenantScope) context.Context {
	return context.WithValue(ctx, tenantScopeKey{}, scope)
}
func accountOf(ctx context.Context) string {
	s := scopeOf(ctx)
	if s.AccountID != "" {
		return s.AccountID
	}
	if s.UserID == "" {
		return "csdn-main"
	}
	return ""
}

type tenantPool struct{ *pgxpool.Pool }

func (p *tenantPool) Begin(ctx context.Context) (pgx.Tx, error) {
	return p.BeginTx(ctx, pgx.TxOptions{})
}
func (p *tenantPool) BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	tx, err := p.Pool.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	s := scopeOf(ctx)
	_, err = tx.Exec(ctx, "SELECT set_config('post_bridge.user_id',$1,true),set_config('post_bridge.account_id',$2,true),set_config('post_bridge.caller_id',$3,true)", s.UserID, accountOf(ctx), s.CallerID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}
func (p *tenantPool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx, err := p.Begin(ctx)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return tag, err
	}
	return tag, tx.Commit(ctx)
}

type tenantRows struct {
	pgx.Rows
	tx     pgx.Tx
	ctx    context.Context
	closed bool
}

func (r *tenantRows) Close() {
	if !r.closed {
		r.closed = true
		r.Rows.Close()
		_ = r.tx.Rollback(r.ctx)
	}
}
func (r *tenantRows) Next() bool {
	ok := r.Rows.Next()
	if !ok {
		r.Close()
	}
	return ok
}
func (p *tenantPool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx, err := p.Begin(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return &tenantRows{Rows: rows, tx: tx, ctx: ctx}, nil
}

type tenantRow struct {
	row pgx.Row
	tx  pgx.Tx
	ctx context.Context
	err error
}

func (r *tenantRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	defer r.tx.Rollback(r.ctx)
	if err := r.row.Scan(dest...); err != nil {
		return err
	}
	return r.tx.Commit(r.ctx)
}
func (p *tenantPool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	tx, err := p.Begin(ctx)
	if err != nil {
		return &tenantRow{err: err}
	}
	return &tenantRow{row: tx.QueryRow(ctx, sql, args...), tx: tx, ctx: ctx}
}
