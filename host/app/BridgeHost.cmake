# BridgeHost target, included at the end of the SDK's ARA_Examples/CMakeLists.txt (see tools/setup_sdk.sh;
# CMAKE_CURRENT_SOURCE_DIR is the SDK's ARA_Examples folder). Reuses the SDK's TestHost classes (ARA document
# model and host interfaces) and adds the bridge code from host/, reached through the BridgeHost symlink.

enable_language(OBJCXX)

set(BH "${CMAKE_CURRENT_SOURCE_DIR}/BridgeHost")

# the build named by --version: git describe of the repository (with -dirty for uncommitted changes to
# tracked files), else the configure date
execute_process(COMMAND git -C "${BH}" describe --always --dirty
    OUTPUT_VARIABLE BRIDGEHOST_BUILD OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET RESULT_VARIABLE BRIDGEHOST_GIT_RESULT)
if(NOT BRIDGEHOST_GIT_RESULT EQUAL 0 OR BRIDGEHOST_BUILD STREQUAL "")
    string(TIMESTAMP BRIDGEHOST_BUILD "built-%Y-%m-%d")
endif()
configure_file("${BH}/app/BuildInfo.cpp.in" "${CMAKE_CURRENT_BINARY_DIR}/BridgeHostBuildInfo.cpp" @ONLY)

add_executable(BridgeHost
    # SDK TestHost: ARA host interfaces and model (everything except its main.cpp and TestCases.cpp)
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAArchivingController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAAudioAccessController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAContentAccessController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAModelUpdateController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAPlaybackController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARADocumentController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/CompanionAPIs.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ModelObjects.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/TestHost.cpp"
    # bridge libraries (also built standalone by host/CMakeLists.txt)
    "${BH}/common/Wav.cpp"
    "${BH}/realign/Realign.cpp"
    "${BH}/plugins/PlugInFinder.cpp"
    "${BH}/jobio/Job.mm"
    "${BH}/audio/AudioDecode.mm"
    "${BH}/audio/OutputDevices.mm"
    "${BH}/hostcore/JobLayout.cpp"
    "${BH}/hostcore/ApplyJob.cpp"
    "${BH}/hostcore/RunGuard.cpp"
    "${BH}/hostcore/Options.cpp"
    "${BH}/hostcore/RenderRepair.cpp"
    "${BH}/hostcore/KeepRaw.cpp"
    "${BH}/hostcore/TransportKey.cpp"
    "${BH}/hostcore/SyncFollow.cpp"
    "${BH}/hostcore/Commands.cpp"
    "${BH}/hostcore/AudioOutput.cpp"
    # the app
    "${BH}/app/BridgeDocument.cpp"
    "${BH}/app/OfflineRenderer.cpp"
    "${BH}/app/JobRender.cpp"
    "${BH}/app/Playback.mm"
    "${BH}/app/HostApp.mm"
    "${BH}/app/main.mm"
    "${CMAKE_CURRENT_BINARY_DIR}/BridgeHostBuildInfo.cpp"
)

target_include_directories(BridgeHost PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost"
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${BH}"
)

target_compile_definitions(BridgeHost PRIVATE
    -DARA_ENABLE_VST3=1
    -DARA_ENABLE_CLAP=0
)

target_compile_features(BridgeHost PRIVATE cxx_std_17)

target_compile_options(BridgeHost PRIVATE
    $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>
)
# the Xcode generator does not pass the OBJCXX option above on; this is what enables ARC there
set_target_properties(BridgeHost PROPERTIES
    XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC YES
)

target_link_libraries(BridgeHost PRIVATE
    ARAExamplesCommon
    ARA_Host_Library
    pluginterfaces   # FUnknown::iid, needed by the loader's component handler
    sdk_hosting      # HostApplication (VST3 host context)
    sdk_common
    base
    "-framework ApplicationServices"
    "-framework Cocoa"
    "-framework AVFoundation"
    "-framework AudioToolbox"
    "-framework CoreAudio"
    "-framework CoreFoundation"
    "-framework Foundation"
)

configure_ARA_Examples_target(BridgeHost)
