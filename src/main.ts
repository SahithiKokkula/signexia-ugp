import {enableProdMode, provideZoneChangeDetection} from '@angular/core';
import {environment} from './environments/environment';
import {Capacitor} from '@capacitor/core';
import {initializeApp} from 'firebase/app';
import {initializeAppCheck, ReCaptchaV3Provider} from 'firebase/app-check';
import {appConfig} from './app/app.config';
import {AppComponent} from './app/app.component';
import {bootstrapApplication} from '@angular/platform-browser';

if (environment.production) {
  enableProdMode();
}

if (!Capacitor.isNativePlatform()) {
  const app = initializeApp(environment.firebase);
  
  // Initialize App Check only for production
  // For development/localhost, we rely on token interceptor to skip AppCheck headers
  if (environment.production && environment.reCAPTCHAKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(environment.reCAPTCHAKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
}

bootstrapApplication(AppComponent, {
  ...appConfig,
  providers: [provideZoneChangeDetection(), ...appConfig.providers],
}).catch(err => console.error(err));
