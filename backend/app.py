"""
Python Flask backend for Speech Recognition using google-speech-recognition library
This backend avoids network restrictions by running locally.

Install dependencies:
  pip install flask flask-cors speech_recognition pydub

Run the server:
  python app.py
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import speech_recognition as sr
from pydub import AudioSegment
import tempfile
import os
import shutil
import glob
from werkzeug.utils import secure_filename
import logging
import warnings
from io import BytesIO

# Suppress pydub ffmpeg warning - we'll handle it gracefully
warnings.filterwarnings('ignore', message='Couldn\'t find ffmpeg or avconv')

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Try to locate ffmpeg in common Windows locations
def setup_ffmpeg_path():
    """Try to find ffmpeg in system PATH or common installation locations."""
    # Try to locate ffmpeg in common Windows installation paths
    common_paths = [
        # winget installation (WinGet-specific package path)
        os.path.expandvars(r"%USERPROFILE%\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin"),
        # winget installation (per-user, typical path)
        os.path.expandvars(r"%USERPROFILE%\AppData\Local\Programs\ffmpeg\bin"),
        # scoop
        os.path.expandvars(r"%USERPROFILE%\scoop\shims"),
        os.path.expandvars(r"%USERPROFILE%\scoop\apps\ffmpeg\current\bin"),
        # Manual installation
        r"C:\Program Files\ffmpeg\bin",
        r"C:\Program Files (x86)\ffmpeg\bin",
        # Chocolatey
        r"C:\ProgramData\chocolatey\bin",
    ]
    
    # First check system PATH
    if shutil.which('ffmpeg'):
        logger.info("✅ ffmpeg found in system PATH")
        return True
    
    logger.info("🔍 ffmpeg not in PATH, searching WinGet/common locations...")
    
    # Try adding common paths
    for path_pattern in common_paths:
        # Handle glob patterns for WinGet paths
        if '*' in path_pattern:
            matches = glob.glob(path_pattern)
            for path in matches:
                if os.path.exists(path):
                    ffmpeg_exe = os.path.join(path, 'ffmpeg.exe')
                    if os.path.exists(ffmpeg_exe):
                        logger.info(f"✅ Found ffmpeg at: {ffmpeg_exe}")
                        os.environ['PATH'] = path + os.pathsep + os.environ['PATH']
                        logger.info(f"✅ Added to PATH: {path}")
                        if shutil.which('ffmpeg'):
                            logger.info("✅ ffmpeg is now accessible to subprocess")
                            return True
        else:
            # Direct path check
            if os.path.exists(path_pattern):
                ffmpeg_exe = os.path.join(path_pattern, 'ffmpeg.exe')
                if os.path.exists(ffmpeg_exe):
                    logger.info(f"✅ Found ffmpeg at: {ffmpeg_exe}")
                    os.environ['PATH'] = path_pattern + os.pathsep + os.environ['PATH']
                    logger.info(f"✅ Added to PATH: {path_pattern}")
                    if shutil.which('ffmpeg'):
                        logger.info("✅ ffmpeg is now accessible to subprocess")
                        return True
    
    # Last resort: deep search in AppData WinGet packages
    try:
        winget_path = os.path.expandvars(r"%USERPROFILE%\AppData\Local\Microsoft\WinGet\Packages")
        logger.info(f"🔍 Searching WinGet packages for ffmpeg...")
        if os.path.exists(winget_path):
            for item in os.listdir(winget_path):
                if 'ffmpeg' in item.lower():
                    ffmpeg_bin = os.path.join(winget_path, item)
                    for subdir in os.listdir(ffmpeg_bin):
                        bin_dir = os.path.join(ffmpeg_bin, subdir, 'bin')
                        if os.path.exists(bin_dir) and os.path.exists(os.path.join(bin_dir, 'ffmpeg.exe')):
                            logger.info(f"✅ Found ffmpeg at: {os.path.join(bin_dir, 'ffmpeg.exe')}")
                            os.environ['PATH'] = bin_dir + os.pathsep + os.environ['PATH']
                            logger.info(f"✅ Added to PATH: {bin_dir}")
                            if shutil.which('ffmpeg'):
                                logger.info("✅ ffmpeg is now accessible")
                                return True
    except Exception as e:
        logger.debug(f"WinGet search error: {e}")
    
    logger.error("❌ ffmpeg executable not found")
    logger.error("📦 Install ffmpeg: winget install ffmpeg")
    logger.error("   Or download from: https://ffmpeg.org/download.html")
    return False

# Call setup before starting server
setup_ffmpeg_path()
UPLOAD_FOLDER = tempfile.gettempdir()
ALLOWED_EXTENSIONS = {'wav', 'mp3', 'ogg', 'flac', 'webm'}
MAX_FILE_SIZE = 25 * 1024 * 1024  # 25MB

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE


def allowed_file(filename):
    """Check if file extension is allowed."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({'status': 'healthy', 'service': 'speech-recognition-backend'}), 200


@app.route('/api/speech-to-text', methods=['POST'])
def speech_to_text():
    """
    Convert audio file to text using speech_recognition library.
    
    Expected POST data:
    - audio: audio file (wav, mp3, ogg, flac, webm)
    - language: language code (default: 'en-US')
    
    Returns:
    - text: recognized text
    - error: error message if recognition failed
    """
    try:
        # Validate request has audio file
        if 'audio' not in request.files:
            return jsonify({'error': 'No audio file provided'}), 400
        
        audio_file = request.files['audio']
        if audio_file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        
        # Get language parameter (default to 'en-US')
        language = request.form.get('language', 'en-US')
        
        # Detect original format from filename or content-type
        original_filename = secure_filename(audio_file.filename)
        file_ext = original_filename.rsplit('.', 1)[1].lower() if '.' in original_filename else 'webm'
        mime_type = audio_file.content_type or 'audio/webm'
        
        logger.info(f"📥 Received audio file: {original_filename}, type: {mime_type}, ext: {file_ext}")
        
        # Map extension to pydub format parameter (critical!)
        format_map = {
            'webm': 'webm',
            'ogg': 'ogg',
            'opus': 'ogg',  # Opus is in OGG container
            'mp3': 'mp3',
            'wav': 'wav',
            'flac': 'flac',
        }
        audio_format = format_map.get(file_ext, file_ext)
        logger.info(f"🎵 Using format parameter: {audio_format}")
        
        # Read audio file into memory (avoiding Windows file locking issues)
        audio_data = audio_file.read()
        file_size = len(audio_data)
        logger.info(f"📊 Audio data size: {file_size} bytes")
        
        if file_size == 0:
            return jsonify({
                'error': 'empty_audio',
                'message': 'Received empty audio file'
            }), 400
        
        # Convert to WAV if needed (using in-memory streams)
        needs_conversion = file_ext.lower() in ['webm', 'ogg', 'mp3', 'flac', 'opus']
        wav_audio = None
        
        try:
            if needs_conversion:
                logger.info(f"🔄 Converting {file_ext.upper()} to WAV...")
                # Load audio from BytesIO
                input_stream = BytesIO(audio_data)
                audio = AudioSegment.from_file(input_stream, format=audio_format)
                logger.info(f"✅ Loaded {file_ext.upper()} audio: {len(audio)} ms duration")
                
                # Export to WAV in memory
                wav_stream = BytesIO()
                audio.export(wav_stream, format='wav')
                wav_stream.seek(0)
                wav_audio = wav_stream
                logger.info(f"✅ Converted to WAV: {wav_stream.getbuffer().nbytes} bytes")
            else:
                # Already WAV, use as-is
                logger.info("✅ File is already WAV format")
                wav_audio = BytesIO(audio_data)
                
        except Exception as e:
            logger.error(f"❌ Conversion failed: {str(e)}", exc_info=True)
            # Check if ffmpeg is available
            if not shutil.which('ffmpeg'):
                error_msg = (
                    'ffmpeg is not installed or not in PATH. This is required to convert '
                    f'{file_ext.upper()} to WAV format. '
                    'Install from: https://ffmpeg.org/download.html or use package manager: '
                    'Windows: winget install ffmpeg | macOS: brew install ffmpeg | Linux: apt-get install ffmpeg'
                )
            else:
                error_msg = f'Audio conversion error: {str(e)}'
            
            return jsonify({
                'error': 'audio_conversion_failed',
                'message': error_msg
            }), 400
        
        try:
            # Initialize recognizer
            recognizer = sr.Recognizer()
            
            # Configure recognition parameters
            recognizer.energy_threshold = 300  # Lower threshold for quieter speech
            recognizer.dynamic_energy_threshold = True
            recognizer.pause_threshold = 0.8
            
            logger.info("🎤 Loading audio for recognition...")
            
            # Load from WAV stream
            with sr.AudioFile(wav_audio) as source:
                # Adjust for ambient noise
                recognizer.adjust_for_ambient_noise(source, duration=0.5)
                audio_data = recognizer.record(source)
            
            logger.info(f"📊 Audio loaded. Duration: {len(audio_data.frame_data) / audio_data.sample_rate:.1f}s")
            
            # Recognize speech using Google Speech Recognition
            try:
                logger.info(f"🔍 Sending to Google Speech Recognition (language: {language})...")
                text = recognizer.recognize_google(audio_data, language=language)
                logger.info(f"✅ Recognition successful: {text}")
                return jsonify({'text': text, 'success': True}), 200
            
            except sr.UnknownValueError:
                logger.warning("⚠️ Could not understand audio")
                return jsonify({
                    'error': 'speech_not_understood',
                    'message': 'Could not understand audio. Please speak clearly.'
                }), 400
            
            except sr.RequestError as e:
                logger.error(f"❌ Speech recognition request error: {str(e)}")
                return jsonify({
                    'error': 'recognition_service_error',
                    'message': f'Error accessing speech recognition service: {str(e)}'
                }), 500
        
        except Exception as e:
            logger.error(f"❌ Recognition failed: {str(e)}", exc_info=True)
            return jsonify({
                'error': 'recognition_failed',
                'message': f'Speech recognition error: {str(e)}'
            }), 500
    
    except Exception as e:
        logger.error(f"❌ Unexpected error in speech_to_text: {str(e)}", exc_info=True)
        return jsonify({
            'error': 'server_error',
            'message': f'An unexpected error occurred: {str(e)}'
        }), 500


@app.route('/api/supported-languages', methods=['GET'])
def supported_languages():
    """Return list of supported languages for Google Speech Recognition."""
    # Common language codes supported by Google Speech Recognition
    languages = {
        'en-US': 'English (US)',
        'en-GB': 'English (UK)',
        'en-IN': 'English (India)',
        'es-ES': 'Spanish',
        'fr-FR': 'French',
        'de-DE': 'German',
        'it-IT': 'Italian',
        'pt-BR': 'Portuguese (Brazil)',
        'ru-RU': 'Russian',
        'zh-CN': 'Chinese (Simplified)',
        'zh-TW': 'Chinese (Traditional)',
        'ja-JP': 'Japanese',
        'ko-KR': 'Korean',
        'ar-SA': 'Arabic',
        'hi-IN': 'Hindi',
    }
    return jsonify({'languages': languages}), 200


@app.errorhandler(413)
def request_entity_too_large(error):
    """Handle oversized file uploads."""
    return jsonify({'error': 'file_too_large', 'message': 'Audio file is too large'}), 413


@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors."""
    return jsonify({'error': 'not_found', 'message': 'Endpoint not found'}), 404


if __name__ == '__main__':
    logger.info("Starting Speech Recognition Backend...")
    logger.info("Server running on http://localhost:5000")
    logger.info("Health check: GET http://localhost:5000/health")
    logger.info("Speech to Text: POST http://localhost:5000/api/speech-to-text")
    app.run(debug=True, host='0.0.0.0', port=5000)
