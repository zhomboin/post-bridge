package bridge

import (
	"context"
	"encoding/json"
	"testing"
)

func publishedNoteSnapshot() *NotesSnapshot {
	n := noteSnapshot()
	n.Items[0].Status = "published"
	n.Items[0].Type = "image"
	n.Items[0].CoverURLs = []string{"https://sns-webpic-qc.xhscdn.com/synthetic.jpg"}
	n.Items[0].NoteURL = "https://www.xiaohongshu.com/explore/" + n.Items[0].ID
	return n
}
func TestNoteInsightsValidation(t *testing.T) {
	zero := int64(0)
	negative := int64(-2)
	n := publishedNoteSnapshot()
	n.Profile = &NoteProfile{Nickname: "合成昵称", AvatarURL: "https://img.xiaohongshu.com/avatar/test.jpg", Followers: &zero}
	n.Stats = &NoteStats{BeginAt: "2026-11-01T00:00:00Z", EndAt: "2026-11-07T00:00:00Z", Views: &zero, NetFollowers: &negative}
	n.Trend = []NoteTrend{{Date: "2026-11-07", Views: &zero, Followers: &negative}}
	if validateNotes(n, n.Username, n.UserID) != nil {
		t.Fatal("valid enriched snapshot")
	}
	for _, alter := range []func(*NotesSnapshot){func(n *NotesSnapshot) { n.Profile.AvatarURL = "https://evil.test/a" }, func(n *NotesSnapshot) { n.Items[0].CoverURLs = []string{"javascript:alert(1)"} }, func(n *NotesSnapshot) { n.Items[0].NoteURL = "https://evil.test" }, func(n *NotesSnapshot) { n.Stats.Views = &negative }, func(n *NotesSnapshot) { n.Trend = append(n.Trend, n.Trend[0]) }} {
		raw, _ := json.Marshal(n)
		var bad NotesSnapshot
		json.Unmarshal(raw, &bad)
		alter(&bad)
		if validateNotes(&bad, bad.Username, bad.UserID) == nil {
			t.Fatal("invalid enriched snapshot accepted")
		}
	}
}
func TestNoteDetailIsolationCoalescingAndRetention(t *testing.T) {
	s := testStore(t)
	configureXHS(t, s)
	ctx := context.Background()
	snapshot := publishedNoteSnapshot()
	c := claimNotes(t, s, "seed-note")
	if err := s.Complete(ctx, c.Job.ID, notesResult(c, snapshot)); err != nil {
		t.Fatal(err)
	}
	id := snapshot.Items[0].ID
	if _, _, err := s.createNoteJob(ctx, "xhs-main", "read_note", "bad-note", "cccccccccccccccccccccccc"); err != ErrNotFound {
		t.Fatal("unknown note", err)
	}
	j, created, err := s.createNoteJob(ctx, "xhs-main", "read_note", "read", id)
	if err != nil || !created {
		t.Fatal(err)
	}
	alias, created, err := s.createNoteJob(ctx, "xhs-main", "read_note", "read-alias", id)
	if err != nil || created || alias.ID != j.ID {
		t.Fatal("coalescing", err)
	}
	claim, err := s.ClaimForAccount(ctx, "xhs-worker", "xhs-main")
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"checking_login", "verifying"} {
		if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: stage}); err != nil {
			t.Fatal(err)
		}
	}
	body := &NoteBody{ID: id, UserID: syntheticXHS().UserID, Title: "合成正文", Text: "<script>仅按文本展示</script>", Images: []string{"https://sns-webpic-qc.xhscdn.com/body.jpg"}, Tags: []string{"合成"}}
	result := CompleteInput{LeaseToken: claim.LeaseToken, Status: "succeeded", Note: body, AccountIdentity: &AccountIdentity{Username: syntheticXHS().Username, UserID: syntheticXHS().UserID}}
	body.UserID = "cccccccccccccccccccccccc"
	if s.Complete(ctx, j.ID, result) != ErrInvalid {
		t.Fatal("wrong author accepted")
	}
	body.UserID = syntheticXHS().UserID
	if err = s.Complete(ctx, j.ID, result); err != nil {
		t.Fatal(err)
	}
	detail, err := s.Note(ctx, "xhs-main", id)
	if err != nil || detail.Body == nil || detail.Body.Text != body.Text || detail.FetchedAt == nil {
		t.Fatal("body", err)
	}
	if _, err = s.Note(ctx, "csdn-main", id); err != ErrNotFound {
		t.Fatal("cross platform body", err)
	}
	other := syntheticXHS()
	other.ID = "xhs-other"
	other.Username = "other-red"
	other.UserID = "cccccccccccccccccccccccc"
	if err = s.ConfigurePlatformAccounts(ctx, []PlatformAccountConfig{other}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Note(ctx, other.ID, id); err != ErrNotFound {
		t.Fatal("cross account body", err)
	}
	j, _, err = s.createNoteJob(ctx, "xhs-main", "read_note", "failed-read", id)
	if err != nil {
		t.Fatal(err)
	}
	claim, err = s.ClaimForAccount(ctx, "xhs-worker", "xhs-main")
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: claim.LeaseToken, Status: "failed", ErrorCode: "adapter_mismatch"}); err != nil {
		t.Fatal(err)
	}
	detail, err = s.Note(ctx, "xhs-main", id)
	if err != nil || detail.Body == nil || detail.Body.Text != body.Text {
		t.Fatal("failed read lost body", err)
	}
	j, _, err = s.createNoteJob(ctx, "xhs-main", "read_note", "stale-read", id)
	if err != nil {
		t.Fatal(err)
	}
	claim, err = s.ClaimForAccount(ctx, "xhs-worker", "xhs-main")
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"checking_login", "verifying"} {
		if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: stage}); err != nil {
			t.Fatal(err)
		}
	}
	s.pool.Exec(ctx, "UPDATE account SET connection_version=connection_version+1 WHERE id='xhs-main'")
	result.LeaseToken = claim.LeaseToken
	if err = s.Complete(ctx, j.ID, result); err != ErrConflict {
		t.Fatal("stale connection body accepted", err)
	}
	if validateNoteBody(&NoteBody{ID: id, UserID: syntheticXHS().UserID, Images: []string{}, Tags: []string{}, Text: "ok"}, id, syntheticXHS().UserID) != nil {
		t.Fatal("empty media rejected")
	}
}
