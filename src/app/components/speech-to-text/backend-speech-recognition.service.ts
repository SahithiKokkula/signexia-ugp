import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, Subject} from 'rxjs';
import {tap} from 'rxjs/operators';

export interface SpeechRecognitionResponse {
  text?: string;
  success?: boolean;
  error?: string;
  message?: string;
}

export interface SupportedLanguage {
  [key: string]: string;
}

@Injectable({
  providedIn: 'root',
})
export class BackendSpeechRecognitionService {
  private backendUrl = 'http://localhost:5000'; // Change this if backend runs on different host
  private isRecording = false;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private audioStream: MediaStream | null = null;

  // Events
  public recordingStarted$ = new Subject<void>();
  public recordingEnded$ = new Subject<void>();
  public recordingProgress$ = new Subject<number>();

  private recordingTime = 0;
  private recordingInterval: number | null = null;

  constructor(private http: HttpClient) {}

  /**
   * Check if backend is available
   */
  checkBackendHealth(): Observable<any> {
    return this.http.get(`${this.backendUrl}/health`);
  }

  /**
   * Start recording audio from microphone
   */
  async startRecording(): Promise<void> {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioStream = stream;
      this.audioChunks = [];
      this.isRecording = true;
      this.recordingTime = 0;

      // Create MediaRecorder with audio/webm;codecs=opus
      const mimeType = this.getMimeType();
      this.mediaRecorder = new MediaRecorder(stream, {mimeType});

      this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstart = () => {
        console.log('Recording started');
        this.recordingStarted$.next();
        this.startRecordingTimer();
      };

      this.mediaRecorder.onstop = () => {
        console.log('Recording ended');
        this.stopRecordingTimer();
        this.recordingEnded$.next();
      };

      // Start recording with 200ms timeslice to ensure ondataavailable fires periodically
      this.mediaRecorder.start(200);
      console.log('Audio recording started');
    } catch (error) {
      console.error('Error starting recording:', error);
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new Error('Microphone permission denied');
      }
      throw error;
    }
  }

  /**
   * Stop recording and return audio blob
   */
  async stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        console.warn('MediaRecorder is not active');

        // Return blob from previous chunks if available
        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {type: 'audio/webm'});
          this.audioChunks = [];
          console.log('✅ Returning previous recording. Blob size:', audioBlob.size, 'bytes');
          resolve(audioBlob);
        } else {
          console.error('❌ No audio chunks captured');
          resolve(null);
        }
        return;
      }

      try {
        // Counter to track how many chunks we have before stopping
        const initialChunkCount = this.audioChunks.length;
        console.log(`📊 Current chunks before stop: ${initialChunkCount}`);

        // Create a one-time handler for the stop event
        const handleRecordingStop = () => {
          console.log('🛑 MediaRecorder stopped event fired');

          // Wait longer to ensure all ondataavailable callbacks are fully processed
          setTimeout(() => {
            const finalChunkCount = this.audioChunks.length;
            console.log(`📊 Final chunks after stop: ${finalChunkCount}`);

            if (this.audioChunks.length === 0) {
              console.error('❌ No audio chunks captured during recording');
              this.isRecording = false;

              // Stop all tracks
              if (this.audioStream) {
                this.audioStream.getTracks().forEach((track) => track.stop());
                this.audioStream = null;
              }

              resolve(null);
            } else {
              // Create blob from chunks
              const audioBlob = new Blob(this.audioChunks, {type: 'audio/webm'});
              const blobSize = audioBlob.size;

              // Debug info
              const totalSize = this.audioChunks.reduce((sum, chunk) => sum + chunk.size, 0);
              console.log(`✅ Recording complete. Chunks: ${this.audioChunks.length}, Total size: ${totalSize} bytes, Blob size: ${blobSize} bytes`);

              this.audioChunks = [];
              this.isRecording = false;

              // Stop all tracks
              if (this.audioStream) {
                this.audioStream.getTracks().forEach((track) => track.stop());
                this.audioStream = null;
              }

              resolve(audioBlob);
            }
          }, 250);
        };

        // Replace the onstop handler with our new one
        this.mediaRecorder.onstop = handleRecordingStop;
        this.mediaRecorder.stop();
      } catch (error) {
        console.error('❌ Error stopping recording:', error);
        resolve(null);
      }
    });
  }

  /**
   * Send audio blob to backend for speech recognition
   */
  recognizeAudio(audioBlob: Blob, language: string = 'en-US'): Observable<SpeechRecognitionResponse> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');
    formData.append('language', language);

    console.log(`Sending audio to backend for recognition (language: ${language}, size: ${audioBlob.size} bytes)`);

    return this.http.post<SpeechRecognitionResponse>(`${this.backendUrl}/api/speech-to-text`, formData).pipe(
      tap({
        next: (response) => {
          if (response.success) {
            console.log('Recognition successful:', response.text);
          } else {
            console.error('Recognition error:', response.error, response.message);
          }
        },
        error: (error) => {
          console.error('Backend request error:', error);
        },
      })
    );
  }

  /**
   * Get supported languages from backend
   */
  getSupportedLanguages(): Observable<{languages: SupportedLanguage}> {
    return this.http.get<{languages: SupportedLanguage}>(`${this.backendUrl}/api/supported-languages`);
  }

  /**
   * Cancel recording
   */
  cancelRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }

    this.audioChunks = [];
    this.isRecording = false;
    this.stopRecordingTimer();
    console.log('Recording cancelled');
  }

  /**
   * Download recorded audio for debugging
   */
  downloadRecording(): void {
    if (this.audioChunks.length === 0) {
      console.warn('No recording to download');
      return;
    }

    const audioBlob = new Blob(this.audioChunks, {type: 'audio/webm'});
    const url = URL.createObjectURL(audioBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `recording-${Date.now()}.webm`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Get current recording state
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get current recording time in milliseconds
   */
  getRecordingTime(): number {
    return this.recordingTime;
  }

  // Private helper methods
  private getMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log(`Using MIME type: ${type}`);
        return type;
      }
    }

    // Fallback to default
    console.warn('No supported MIME type found, using default');
    return 'audio/webm';
  }

  private startRecordingTimer(): void {
    this.recordingTime = 0;
    this.recordingInterval = window.setInterval(() => {
      this.recordingTime += 100;
      this.recordingProgress$.next(this.recordingTime);
    }, 100);
  }

  private stopRecordingTimer(): void {
    if (this.recordingInterval !== null) {
      clearInterval(this.recordingInterval);
      this.recordingInterval = null;
    }
  }
}
