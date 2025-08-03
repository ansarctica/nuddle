package types

import (
	"strings"
)

type Session struct {
	SESSION_NAME   string `json:"SESSION_NAME"`
	SESSION_TYPE   string `json:"SESSION_TYPE,omitempty"`
	TIME_RECORD    string `json:"TIME_RECORD,omitempty"`
	TIME_RELEVANCE int    `json:"TIME_RELEVANCE,omitempty"`
	TIME_BITS      []byte `json:"TIME_BITS,omitempty"`
	ENROLLMENT     string `json:"ENROLLMENT"`
	AVAILABILITY   int    `json:"AVAILABILITY"`
	PROFESSOR      string `json:"PROFESSOR"`
}

type Course struct {
	COURSE_NAME     string           `json:"COURSE_NAME"`
	COURSE_SESSIONS []Session        `json:"COURSE_SESSIONS,omitempty"`
	TYPES           []string         `json:"TYPES,omitempty"`
	GROUPED         map[string][]int `json:"GROUPED,omitempty"`
}

func Normalize(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func (c *Course) BuildTypeIndex(stripType bool) {
	c.GROUPED = make(map[string][]int)
	c.TYPES = c.TYPES[:0]
	seen := make(map[string]struct{})

	for i := range c.COURSE_SESSIONS {
		t := strings.TrimSpace(c.COURSE_SESSIONS[i].SESSION_TYPE)
		if t == "" {
			t = "?"
		}
		c.GROUPED[t] = append(c.GROUPED[t], i)
		if _, ok := seen[t]; !ok {
			c.TYPES = append(c.TYPES, t)
			seen[t] = struct{}{}
		}
		if stripType {
			c.COURSE_SESSIONS[i].SESSION_TYPE = ""
		}
	}
}
