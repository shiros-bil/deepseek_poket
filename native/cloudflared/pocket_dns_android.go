package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// Android has no resolv.conf. The app supplies DNS servers for its active
// network, including SRV lookups used by edge discovery. No TLS settings change.
func init() {
	servers := strings.FieldsFunc(os.Getenv("POCKET_DNS_SERVERS"), func(r rune) bool { return r == ',' || r == ' ' })
	if len(servers) == 0 {
		return
	}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var lastError error
			for _, server := range servers {
				dialer := net.Dialer{Timeout: 4 * time.Second}
				connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(server, "53"))
				if err == nil {
					return connection, nil
				}
				lastError = err
			}
			return nil, fmt.Errorf("Android network DNS unavailable: %w", lastError)
		},
	}
}
