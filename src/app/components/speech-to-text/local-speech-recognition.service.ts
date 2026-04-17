import {Injectable} from '@angular/core';
import {Subject} from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class LocalSpeechRecognitionService {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private audioStream: MediaStream | null = null;
  public isRecording = false;
  public recordingTime = 0;
  private recordingInterval: number | null = null;
  
  // Events
  public recordingStarted$ = new Subject<void>();
  public recordingEnded$ = new Subject<void>();
  public recordingProgress$ = new Subject<number>();

  constructor() {}

  async startRecording(): Promise<void> {
    try {
      console.log('Starting local audio recording...');
      
      // Request microphone access
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(this.audioStream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstart = () => {
        this.isRecording = true;
        this.recordingTime = 0;
        this.recordingStarted$.next();
        console.log('Local audio recording started');

        // Track recording time
        this.recordingInterval = window.setInterval(() => {
          this.recordingTime++;
          this.recordingProgress$.next(this.recordingTime);
        }, 100);
      };

      this.mediaRecorder.onerror = (error: DOMException) => {
        console.error('MediaRecorder error:', error.message);
      };

      this.mediaRecorder.start();
    } catch (error) {
      console.error('Error accessing microphone:', error);
      throw error;
    }
  }

  async stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        console.warn('MediaRecorder is not active');
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        this.isRecording = false;
        if (this.recordingInterval !== null) {
          clearInterval(this.recordingInterval);
        }

        // Create audio blob
        const audioBlob = new Blob(this.audioChunks, {type: 'audio/webm'});
        console.log('Recording stopped. Audio blob size:', audioBlob.size);

        // Stop all audio tracks
        if (this.audioStream) {
          this.audioStream.getTracks().forEach(track => track.stop());
          this.audioStream = null;
        }

        this.recordingEnded$.next();
        resolve(audioBlob);
      };

      this.mediaRecorder.stop();
    });
  }

  cancelRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }

    this.isRecording = false;
    this.audioChunks = [];

    if (this.recordingInterval !== null) {
      clearInterval(this.recordingInterval);
    }

    console.log('Recording cancelled');
  }

  /**
   * Treat recorded audio as user-spoken text
   * Used as a fallback when cloud transcription isn't available
   */
  getRecordingFallbackText(): string {
    const minutes = Math.floor(this.recordingTime / 600);
    const seconds = Math.floor((this.recordingTime % 600) / 100);
    return `[Audio recorded: ${minutes}m ${seconds}s - Please transcribe manually or use text input]`;
  }

  /**
   * Get audio blob for potential future cloud processing
   */
  getAudioBlob(): Blob | null {
    return this.audioChunks.length > 0 ? new Blob(this.audioChunks, {type: 'audio/webm'}) : null;
  }

  /**
   * Download the recorded audio for debugging/testing
   */
  downloadRecording(): void {
    if (this.audioChunks.length === 0) {
      console.warn('No audio chunks to download');
      return;
    }

    const audioBlob = new Blob(this.audioChunks, {type: 'audio/webm'});
    const url = URL.createObjectURL(audioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
