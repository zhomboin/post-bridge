package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	bridge "post-bridge/apps/api"
	"syscall"
)

func main() {
	cfg, err := bridge.LoadRuntimeConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err = bridge.Run(ctx, cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
