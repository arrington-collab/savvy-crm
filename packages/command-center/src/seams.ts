// Delivery + scheduling seams for the Daily Flash. This package stays
// UI/infra-free: real delivery (SMS/email) and real scheduling (cron) live in
// apps/web / the infra layer and implement these interfaces. The mocks here
// are what tests (and, for now, the on-demand trigger) run against.

export interface FlashDelivery {
  send(msg: { headline: string; url: string; to: string }): Promise<void>;
}

export class MockFlashDelivery implements FlashDelivery {
  readonly sent: { headline: string; url: string; to: string }[] = [];

  async send(msg: { headline: string; url: string; to: string }): Promise<void> {
    this.sent.push(msg);
  }
}

export interface FlashScheduler {
  schedule(hourDenver: number, run: () => Promise<void>): void;
  triggerNow(run: () => Promise<void>): Promise<void>;
}

export class MockFlashScheduler implements FlashScheduler {
  hour: number | null = null;

  schedule(hourDenver: number, _run: () => Promise<void>): void {
    this.hour = hourDenver;
  }

  async triggerNow(run: () => Promise<void>): Promise<void> {
    await run();
  }
}
