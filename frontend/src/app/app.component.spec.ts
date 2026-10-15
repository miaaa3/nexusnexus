import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { MapComponent } from './map/map.component';

/** The real map needs WebGL, WebSocket and HTTP — the shell test swaps it for a stub. */
@Component({ selector: 'app-map', standalone: true, template: '<div class="stub-map"></div>' })
class StubMapComponent {}

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AppComponent] })
      .overrideComponent(AppComponent, {
        remove: { imports: [MapComponent] },
        add: { imports: [StubMapComponent] },
      })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the map as its only child', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('app-map').length).toBe(1);
    expect(el.querySelector('.stub-map')).not.toBeNull();
  });
});
