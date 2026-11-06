package bridge

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestApprovedCSDNImages(t *testing.T) {
	t.Setenv("CSDN_IMAGE_HOSTS", "files.example.test")
	image := "https://files.example.test/photos/example.jpg"
	markdown := "正文\n\n![图片](" + image + ")\n\n![另一处](" + image + ")"
	got, err := approvedImageMarkdown("合成文章标题", markdown, nil)
	if err != nil || !reflect.DeepEqual(got, []string{image}) {
		t.Fatalf("expected a single approved source, got %v: %v", got, err)
	}
	for _, invalid := range []string{
		"[链接](https://other.example/path/![图片](" + image + "))",
		"    ![缩进代码](" + image + ")",
		"[![嵌套标签](" + image + ")](https://example.test)",
		"[上行标签\n![图片](" + image + ")](https://example.test)",
		"![签名](" + image + "?X-Amz-Signature=test)",
		"![外域](https://other.example.test/photo.png)",
		"![引用][reference]\n\n[reference]: " + image,
		"\\![转义](" + image + ")",
	} {
		if _, err := approvedImageMarkdown("合成文章标题", invalid, nil); err == nil {
			t.Fatal("unsupported image was accepted")
		}
	}
	if _, err := approvedImageMarkdown("合成文章标题", markdown, []string{}); err == nil {
		t.Fatal("revision added an image outside the approved snapshot")
	}
}

func TestConvertedCSDNImages(t *testing.T) {
	src := "https://files.example.test/photos/example.jpg"
	copyURL := "https://i-blog.csdnimg.cn/photo.jpg"
	before := "正文\n\n![图片](" + src + ")\n\n![重复](" + src + ")"
	after := "正文\n\n![图片](" + copyURL + ")\n\n![重复](" + copyURL + ")"
	if !convertedImageMarkdown(before, after, []string{src}) {
		t.Fatal("approved copy substitution rejected")
	}
	if convertedImageMarkdown(before, "    "+after, []string{src}) ||
		convertedImageMarkdown(before, after+"\n额外文字", []string{src}) ||
		convertedImageMarkdown(before, before, []string{src}) ||
		convertedImageMarkdown(before, "正文\n\n![图片]("+copyURL+")\n\n![重复](https://i-blog.csdnimg.cn/other.jpg)", []string{src}) {
		t.Fatal("unapproved converted markdown accepted")
	}
}

func TestImageDistributionCarriesFrozenPlatformMarkdown(t *testing.T) {
	t.Setenv("CSDN_IMAGE_HOSTS", "files.example.test")
	h, store := integrationTestHandler(t)
	client := integrationSeedClient(t, h)
	ctx := context.Background()
	original := "https://files.example.test/photos/example.jpg"
	snapshot := IntegrationSnapshot{
		Title: "带有公开相册图片的文章", BodyFormat: "markdown", Tags: []string{"来源标签"},
		Body: "正文\n\n![图片](" + original + ")",
	}
	fp, err := IntegrationContentFingerprint(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	in := IntegrationPrepareInput{
		RequestID: "image-prepare", SourceID: client.SourceID, ArticleID: "image-article", SourceVersion: 1,
		StateSeq: 1, AuthorizationID: "image-grant", AuthorizationExpiresAt: store.now().Add(time.Hour),
		ContentFingerprint: fp, Snapshot: snapshot,
		Targets: []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	prep, _, err := h.prepareIntegration(ctx, client, in)
	if err != nil || len(prep.Drafts) != 1 || prep.Drafts[0].PublishOptions == nil ||
		!reflect.DeepEqual(prep.Drafts[0].PublishOptions.Tags, snapshot.Tags) {
		t.Fatalf("image preparation did not preserve approved content and settings: %v", err)
	}
	draft := prep.Drafts[0]
	draft.Markdown = strings.ReplaceAll(draft.Markdown, original, "https://files.example.test/unapproved.jpg")
	if _, err := h.updateIntegrationPreparation(ctx, prep.ID, prep.Revision, []IntegrationDraft{draft}); err == nil {
		t.Fatal("unapproved edit accepted")
	}
	prep, err = h.confirmIntegrationPreparation(ctx, prep.ID, prep.Revision)
	if err != nil {
		t.Fatal(err)
	}
	dist, _, err := h.commitIntegrationDistribution(ctx, client, IntegrationSubmitInput{
		RequestID: "image-dispatch", SourceID: in.SourceID, ArticleID: in.ArticleID, SourceVersion: in.SourceVersion,
		StateSeq: in.StateSeq, ContentFingerprint: fp, PreparationID: prep.ID, Targets: in.Targets,
		DraftRevisionIDs: prep.DraftRevisionIDs, ConfirmationFingerprint: prep.ConfirmationFingerprint,
	})
	if err != nil || len(dist.JobIDs) != 1 {
		t.Fatalf("image distribution failed: %v", err)
	}
	claim := guardClaim(t, store)
	if claim.Job.Markdown != snapshot.Body || !reflect.DeepEqual(claim.Job.ImageURLs, []string{original}) {
		t.Fatal("job did not preserve frozen source")
	}
	progress := func(in ProgressInput) error {
		in.LeaseToken = claim.LeaseToken
		return store.Progress(ctx, claim.Job.ID, in)
	}
	if err := progress(ProgressInput{Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	if err := progress(ProgressInput{Stage: "saving"}); err == nil {
		t.Fatal("image save without frozen platform markdown accepted")
	}
	converted := strings.ReplaceAll(snapshot.Body, original, "https://i-blog.csdnimg.cn/copied.jpg")
	if err := progress(ProgressInput{Stage: "saving", PlatformMarkdown: converted}); err != nil {
		t.Fatal(err)
	}
	persisted := guardReadRecord(t, store, claim.Job.ID)
	if persisted.Markdown != snapshot.Body || persisted.PlatformMarkdown != converted {
		t.Fatal("source and converted drafts were not stored separately")
	}
}
