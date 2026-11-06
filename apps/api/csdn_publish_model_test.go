package bridge

import (
	"errors"
	"testing"
	"time"
)

const testPublishHTMLSHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestCSDNPublishCheckpointRequiresHTMLSHA256(t *testing.T) {
	now := time.Now()
	r := newRecord(CreateInput{Kind: "publish"}, now)
	r.Status, r.Stage, r.RemoteID = "running", "filling", "123"
	in := ProgressInput{Stage: "saving", ExternalStarted: true, RemoteID: "123"}
	for _, digest := range []string{"", "invalid"} {
		in.PublishedHTMLSHA256 = digest
		if err := r.progress(in, now); !errors.Is(err, ErrConflict) || r.ExternalStarted {
			t.Fatalf("invalid digest accepted: %q, %v", digest, err)
		}
	}
	in.PublishedHTMLSHA256 = testPublishHTMLSHA256
	if err := r.progress(in, now); err != nil || !r.ExternalStarted || r.PublishedHTMLSHA256 != testPublishHTMLSHA256 {
		t.Fatalf("valid digest did not reach checkpoint: %v", err)
	}
	if err := r.progress(ProgressInput{Stage: "verifying", PublishedHTMLSHA256: testPublishHTMLSHA256}, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("verification could set digest: %v", err)
	}
}

func TestCSDNPublishCompletionRequiresWriteCheckpointAndFixedDraftID(t *testing.T) {
	now := time.Now()
	r := newRecord(CreateInput{Kind: "publish"}, now)
	r.Status, r.Stage, r.RemoteID = "running", "verifying", "123"
	if err := r.complete(CompleteInput{Status: "succeeded", RemoteID: "123"}, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("unstarted publication reported success: %v", err)
	}
	r.ExternalStarted = true
	if err := r.complete(CompleteInput{Status: "succeeded", RemoteID: "123"}, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("publication without an HTML checkpoint reported success: %v", err)
	}
	r.PublishedHTMLSHA256 = testPublishHTMLSHA256
	if err := r.complete(CompleteInput{Status: "succeeded", RemoteID: "456"}, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("publication could switch remote draft: %v", err)
	}
	if err := r.complete(CompleteInput{Status: "succeeded", RemoteID: "123"}, now); err != nil || r.Outcome != "published" || r.RemoteID != "123" {
		t.Fatalf("verified publication result = %+v, %v", r, err)
	}
}

func TestCSDNPublishCancelBeforeWrite(t *testing.T) {
	now := time.Now()
	r := newRecord(CreateInput{Kind: "publish"}, now)
	r.Status, r.RemoteID = "waiting_user", "123"
	if err := r.action("cancel", ActionInput{}, now, nil); err != nil || r.Status != "cancelled" {
		t.Fatalf("could not cancel before any write: %v, status=%s", err, r.Status)
	}
	r.Status, r.ExternalStarted = "waiting_user", true
	if err := r.action("cancel", ActionInput{}, now, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted cancellation after write: %v", err)
	}
	r.Status = "running"
	if err := r.action("cancel", ActionInput{}, now, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted cancellation while reading back a submitted publication: %v", err)
	}
}
