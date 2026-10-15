import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { AlertService } from './alert.service';

describe('AlertService', () => {
  let service: AlertService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AlertService);
  });

  it('pushes an alert and auto-dismisses it after 4 seconds', fakeAsync(() => {
    service.push('info', 'Hello', 'world');
    expect(service.alerts().length).toBe(1);
    expect(service.alerts()[0].title).toBe('Hello');
    tick(4000);
    expect(service.alerts().length).toBe(0);
  }));

  it('keeps at most four toasts, dropping the oldest', fakeAsync(() => {
    for (let i = 1; i <= 6; i++) service.push('info', `t${i}`, '');
    expect(service.alerts().map(a => a.title)).toEqual(['t3', 't4', 't5', 't6']);
    tick(4000);
  }));

  it('dismisses a single alert by id', fakeAsync(() => {
    service.push('warn', 'a', '');
    service.push('warn', 'b', '');
    service.dismiss(service.alerts()[0].id);
    expect(service.alerts().map(a => a.title)).toEqual(['b']);
    tick(4000);
  }));

  it('raises a low-FPS error only on the third consecutive bad reading', fakeAsync(() => {
    service.checkFps(10);
    service.checkFps(10);
    expect(service.alerts().length).toBe(0);
    service.checkFps(10);
    expect(service.alerts()[0].level).toBe('error');
    tick(4000);
  }));

  it('resets the low-FPS streak on a healthy reading', fakeAsync(() => {
    service.checkFps(10);
    service.checkFps(10);
    service.checkFps(60);
    service.checkFps(10);
    service.checkFps(10);
    expect(service.alerts().length).toBe(0);
  }));

  it('rate-limits congestion warnings', fakeAsync(() => {
    service.checkCongestion(0.9);
    service.checkCongestion(0.95);
    expect(service.alerts().length).toBe(1);
    expect(service.alerts()[0].level).toBe('warn');
    tick(4000);
  }));

  it('ignores congestion below the threshold', () => {
    service.checkCongestion(0.5);
    expect(service.alerts().length).toBe(0);
  });

  it('reports a lost WebSocket once, not on every repeat', fakeAsync(() => {
    service.checkWsStatus('DISCONNECTED');
    service.checkWsStatus('DISCONNECTED');
    expect(service.alerts().length).toBe(1);
    expect(service.alerts()[0].title).toBe('Connection Lost');
    tick(4000);
  }));
});
