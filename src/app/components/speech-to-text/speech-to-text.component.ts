import {Component, Input, OnChanges, OnInit, inject, output, SimpleChanges} from '@angular/core';
import {BaseComponent} from '../base/base.component';
import {MatTooltipModule, TooltipPosition} from '@angular/material/tooltip';
import {IonButton, IonIcon} from '@ionic/angular/standalone';
import {TranslocoDirective} from '@jsverse/transloco';
import {addIcons} from 'ionicons';
import {micOutline, stopCircleOutline, micOffOutline, wifiOutline, alertCircleOutline} from 'ionicons/icons';
import {BackendSpeechRecognitionService} from './backend-speech-recognition.service';

@Component({
  selector: 'app-speech-to-text',
  templateUrl: './speech-to-text.component.html',
  styleUrls: ['./speech-to-text.component.css'],
  imports: [IonButton, IonIcon, MatTooltipModule, TranslocoDirective],
})
export class SpeechToTextComponent extends BaseComponent implements OnInit, OnChanges {
  @Input() lang = 'en-US'; // Default to English (US)
  readonly changeText = output<string>();
  @Input() matTooltipPosition: TooltipPosition = 'above';

  private backend = inject(BackendSpeechRecognitionService);

  supportError: string | null = null;
  isRecording = false;
  recordingTime = 0;
  backendConnected = false;
  isProcessing = false; // Show loading state while recognizing

  constructor() {
    super();
    addIcons({stopCircleOutline, micOutline, micOffOutline, wifiOutline, alertCircleOutline});
  }

  ngOnInit(): void {
    this.checkBackendConnection();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.lang) {
      console.log('Language changed to:', this.lang);
    }
  }

  /**
   * Check if backend is available on startup
   */
  private checkBackendConnection(): void {
    this.backend.checkBackendHealth().subscribe({
      next: (response) => {
        console.log('Backend connected:', response);
        this.backendConnected = true;
        this.supportError = null;
      },
      error: (error) => {
        console.error('Backend not available:', error);
        this.backendConnected = false;
        this.supportError = 'backend-unavailable';
      },
    });
  }

  /**
   * Start recording audio from microphone
   */
  async start(): Promise<void> {
    if (!this.backendConnected) {
      console.error('Backend not connected');
      this.supportError = 'backend-unavailable';
      return;
    }

    if (this.isRecording) {
      console.warn('Already recording');
      return;
    }

    try {
      console.log('Starting audio recording...');
      await this.backend.startRecording();
      this.isRecording = true;
      this.supportError = null;
      this.isProcessing = false;

      // Monitor recording time
      this.backend.recordingProgress$.subscribe(time => {
        this.recordingTime = time;
      });

      // Clear previous text
      this.changeText.emit('');
    } catch (error) {
      console.error('Error starting recording:', error);
      if (error instanceof Error && error.message.includes('permission denied')) {
        this.supportError = 'not-allowed';
      } else {
        this.supportError = 'recording-error';
      }
    }
  }

  /**
   * Stop recording and send audio to backend for recognition
   */
  async stop(): Promise<void> {
    if (!this.isRecording) {
      console.warn('Not currently recording');
      return;
    }

    try {
      console.log('Stopping audio recording...');
      this.isRecording = false;
      this.isProcessing = true; // Show loading state

      const audioBlob = await this.backend.stopRecording();

      if (!audioBlob) {
        console.error('❌ No audio blob available - recording produced no data');
        this.isProcessing = false;
        this.supportError = 'recording-error';
        this.changeText.emit('[No audio recorded. Please check microphone permissions and try again.]');
        return;
      }

      console.log(`📊 Audio blob created | Size: ${audioBlob.size} bytes | Type: ${audioBlob.type} | Duration: ${this.recordingTime}ms`);

      // Validate audio blob size
      if (audioBlob.size === 0) {
        console.error('❌ CRITICAL: Audio blob is completely empty - no audio data captured');
        this.isProcessing = false;
        this.supportError = 'recording-error';
        this.changeText.emit('[Audio is empty. Check microphone, speak clearly, and try again.]');
        return;
      }

      // WebM header is ~50-100 bytes, so anything below 500 bytes is likely no real audio
      if (audioBlob.size < 500) {
        console.error(`❌ CRITICAL: Audio blob is suspiciously small (${audioBlob.size} bytes) - likely no actual audio content`);
        console.error('This means the MediaRecorder captured no sound data. Possible causes:');
        console.error('  1. Microphone is muted or not working');
        console.error('  2. Microphone permissions are denied');
        console.error('  3. You didn\'t speak loud enough');
        console.error('  4. Recording time was too short');
        this.isProcessing = false;
        this.supportError = 'recording-error';
        this.changeText.emit('[Insufficient audio captured. Please ensure microphone is on and speak clearly.]');
        return;
      }

      console.log('Sending audio to backend for recognition...');

      // Send to backend for recognition
      this.backend.recognizeAudio(audioBlob, this.lang).subscribe({
        next: (response) => {
          this.isProcessing = false;

          if (response.success && response.text) {
            console.log('✅ Recognition successful:', response.text);
            this.changeText.emit(response.text);
            this.supportError = null;
          } else {
            console.error('❌ Recognition failed:', response.error, response.message);
            this.handleRecognitionError(response.error || 'unknown_error');
          }
        },
        error: (error) => {
          this.isProcessing = false;
          console.error('❌ Backend request error:', error);

          // Check if backend is unavailable
          if (error.status === 0 || error.status === 503) {
            this.supportError = 'backend-unavailable';
            this.backendConnected = false;
            console.error('❌ Backend is not available. Ensure Python server is running on localhost:5000');
          } else if (error.status === 400) {
            // Handle specific error from backend
            const errData = error.error;
            console.error('❌ Backend validation error (400):', errData);
            this.handleRecognitionError(errData.error || 'recognition_failed');
          } else if (error.status === 500) {
            console.error('❌ Backend server error (500):', error.error?.message);
            this.supportError = 'recognition-error';
            // Extract meaningful error message
            if (error.error?.message?.includes('[WinError')) {
              console.error('   File system error - likely temp file issue');
            }
          } else {
            console.error('❌ Unknown backend error, status:', error.status);
            this.supportError = 'recognition-error';
          }
        },
      });
    } catch (error) {
      this.isProcessing = false;
      console.error('❌ Error stopping recording:', error);
      this.supportError = 'recording-error';
    }
  }

  /**
   * Handle recognition errors appropriately
   */
  private handleRecognitionError(errorType: string): void {
    switch (errorType) {
      case 'speech_not_understood':
        console.warn('Speech was not understood');
        this.changeText.emit('[No speech detected - please try again]');
        break;
      case 'recognition_service_error':
        console.error('Recognition service error (network issue with Google servers)');
        this.supportError = 'network-error';
        break;
      case 'backend_unavailable':
        console.error('Backend is not available');
        this.supportError = 'backend-unavailable';
        this.backendConnected = false;
        break;
      default:
        console.error('Unknown recognition error:', errorType);
        this.supportError = 'recognition-error';
    }
  }

  /**
   * Cancel current recording
   */
  cancelRecording(): void {
    this.backend.cancelRecording();
    this.isRecording = false;
    this.isProcessing = false;
    this.recordingTime = 0;
  }

  /**
   * Download recorded audio for debugging
   */
  downloadRecording(): void {
    this.backend.downloadRecording();
  }

  /**
   * Retry backend connection
   */
  retryConnection(): void {
    this.checkBackendConnection();
  }
}
