Pod::Spec.new do |s|
  s.name           = 'ExpoYoutubeDownloader'
  s.version        = '0.1.0'
  s.summary        = 'Native audio/video muxing + duration-fix for expo-youtube-downloader'
  s.description    = 'Muxes separately-downloaded video-only and audio-only files into one playable file via AVFoundation passthrough export, and corrects a duration-doubling bug present in AVFoundation for certain adaptive-stream files.'
  s.author         = ''
  s.homepage       = 'https://github.com/sagark1510/expo-youtube-downloader'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: 'https://github.com/sagark1510/expo-youtube-downloader.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
