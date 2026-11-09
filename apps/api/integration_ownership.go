package bridge

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func integrationOwnedAccounts(ctx context.Context, tx pgx.Tx, owner string, ids []string) error {
	for _, id := range ids {
		var valid bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM account a LEFT JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1 AND ((a.owner_user_id=$2 AND u.enabled) OR ($2='' AND a.owner_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM users))) AND a.enabled AND a.verified)", id, owner).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrIntegrationPermission
		}
	}
	return nil
}

func integrationOwner(ctx context.Context, tx pgx.Tx) (string, error) {
	var owner string
	err := tx.QueryRow(ctx, "SELECT pb_owner()").Scan(&owner)
	return owner, err
}

func recordOwnerScope(ctx context.Context, tx pgx.Tx, owner string) (func(), error) {
	noop := func() {}
	if owner == "" {
		return noop, nil
	}
	if user := scopeOf(ctx).UserID; user != "" && user != owner {
		return noop, ErrNotFound
	}
	var previous string
	if err := tx.QueryRow(ctx, "SELECT pb_user()").Scan(&previous); err != nil {
		return noop, err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('post_bridge.user_id',$1,true)", owner); err != nil {
		return noop, err
	}
	return func() { _, _ = tx.Exec(ctx, "SELECT set_config('post_bridge.user_id',$1,true)", previous) }, nil
}
