package bridge

import (
	"net"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

var csdnImageSyntax = regexp.MustCompile(`!\[([^\[\]\\\r\n]*)\]\((https://[^()<>\s"\\]+)\)`)
var publicImageHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$`)

func csdnImageHosts() []string {
	var hosts []string
	for _, item := range strings.Split(os.Getenv("CSDN_IMAGE_HOSTS"), ",") {
		host := strings.ToLower(strings.TrimSpace(item))
		if publicImageHost.MatchString(host) && net.ParseIP(host) == nil &&
			!strings.HasSuffix(host, ".local") && !strings.HasSuffix(host, ".localhost") {
			hosts = append(hosts, host)
		}
	}
	return hosts
}

func csdnImageURL(value string, hosts []string) bool {
	u, err := url.Parse(value)
	return err == nil && len(value) <= 2048 && u.Scheme == "https" && u.User == nil &&
		u.Host == u.Hostname() && u.Host == strings.ToLower(u.Host) && u.String() == value && u.Path != "" && u.Path != "/" &&
		!strings.ContainsFunc(u.Path, unicode.IsControl) && !strings.ContainsAny(u.Path, "\\\r\n\t") && !slices.Contains(strings.Split(u.Path, "/"), "..") &&
		!slices.Contains(strings.Split(u.Path, "/"), ".") &&
		!strings.ContainsAny(value, "?#&") && !strings.Contains(strings.ToLower(u.EscapedPath()), "%2f") && slices.Contains(hosts, strings.ToLower(u.Host))
}

// imageShape replaces only recognized image destinations outside code fences.
func imageShape(markdown string) (string, []string) {
	markdown = strings.ReplaceAll(strings.ReplaceAll(markdown, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(markdown, "\n")
	var images []string
	var inlineContext markdownInlineContext
	previousLine := -1
	walkMarkdownLines(lines, func(i int, line string) {
		if i != previousLine+1 || strings.TrimSpace(line) == "" {
			inlineContext = markdownInlineContext{}
		}
		lineContext := inlineContext
		inlineContext, previousLine = inlineContext.scan(line), i
		var shaped strings.Builder
		previous := 0
		for _, match := range csdnImageSyntax.FindAllStringSubmatchIndex(line, -1) {
			prefix := line[:match[0]]
			if strings.HasSuffix(prefix, "\\") || lineContext.scan(prefix) != (markdownInlineContext{}) ||
				strings.HasPrefix(line, "    ") || strings.HasPrefix(strings.TrimLeft(line, " "), "\t") {
				continue
			}
			shaped.WriteString(line[previous:match[0]])
			shaped.WriteString("[")
			shaped.WriteString(line[match[2]:match[3]])
			shaped.WriteString("](\x00)")
			images = append(images, line[match[4]:match[5]])
			previous = match[1]
		}
		if previous != 0 {
			shaped.WriteString(line[previous:])
			lines[i] = shaped.String()
		}
	})
	return strings.Join(lines, "\n"), images
}

type markdownInlineContext struct {
	codeTicks  int
	linkLabels int
	linkParens int
}

func (c markdownInlineContext) scan(text string) markdownInlineContext {
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if c.codeTicks == 0 && ch == '\\' {
			i++
			continue
		}
		if c.linkParens > 0 {
			switch ch {
			case '(':
				c.linkParens++
			case ')':
				c.linkParens--
			}
			continue
		}
		if ch == '`' {
			start := i
			for i+1 < len(text) && text[i+1] == '`' {
				i++
			}
			length := i - start + 1
			switch c.codeTicks {
			case 0:
				c.codeTicks = length
			case length:
				c.codeTicks = 0
			}
			continue
		}
		if c.codeTicks != 0 {
			continue
		}
		switch ch {
		case '[':
			c.linkLabels++
		case ']':
			if c.linkLabels == 0 {
				continue
			}
			c.linkLabels--
			if i+1 < len(text) && text[i+1] == '(' {
				c.linkParens++
				i++
			}
		}
	}
	return c
}

func approvedImageMarkdown(title, markdown string, approved []string) ([]string, error) {
	shape, images := imageShape(markdown)
	if strings.ContainsRune(markdown, 0) || len(images) > 20 || len([]rune(markdown)) > 200000 || (len(images) > 0 && strings.Contains(shape, "![")) ||
		ValidateCreate(CreateInput{RequestID: "validate", Kind: "save_draft", Platform: "csdn", Title: title, Markdown: shape}) != nil {
		return nil, ErrIntegrationUnsupported
	}
	hosts := csdnImageHosts()
	unique := []string{}
	for _, image := range images {
		if !csdnImageURL(image, hosts) || (approved != nil && !slices.Contains(approved, image)) {
			return nil, ErrIntegrationUnsupported
		}
		if !slices.Contains(unique, image) {
			unique = append(unique, image)
		}
	}
	if len(unique) > 10 {
		return nil, ErrIntegrationUnsupported
	}
	return unique, nil
}

func convertedImageMarkdown(before, after string, approved []string) bool {
	if strings.ContainsRune(before, 0) || strings.ContainsRune(after, 0) || len([]rune(after)) > 200000 {
		return false
	}
	sourceShape, sourceImages := imageShape(before)
	copyShape, copyImages := imageShape(after)
	if strings.TrimRight(sourceShape, "\n") != strings.TrimRight(copyShape, "\n") || len(sourceImages) != len(copyImages) || len(sourceImages) == 0 {
		return false
	}
	copies := make(map[string]string)
	for i, source := range sourceImages {
		copyURL := copyImages[i]
		if !slices.Contains(approved, source) || !csdnImageURL(copyURL, []string{"i-blog.csdnimg.cn"}) {
			return false
		}
		if previous := copies[source]; previous != "" && previous != copyURL {
			return false
		}
		copies[source] = copyURL
	}
	return true
}
