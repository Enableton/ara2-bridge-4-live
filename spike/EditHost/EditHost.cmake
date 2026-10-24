# Spike: windowed ARA host target, included from the SDK's ARA_Examples/CMakeLists.txt (SPIKE-LOCAL include).
# Reuses the SDK TestHost sources (everything except TestCases.cpp and main.cpp) plus EditHost.mm.

enable_language(OBJCXX)

set(SPIKE_EDITHOST_DIR "${CMAKE_CURRENT_LIST_DIR}")

add_executable(ARAEditHost
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAArchivingController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAAudioAccessController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAContentAccessController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAModelUpdateController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAPlaybackController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARADocumentController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/CompanionAPIs.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ModelObjects.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/TestHost.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/EditHost/EditHost.mm"   # symlink to spike/EditHost (SDK helper wants sources under its tree)
)

target_include_directories(ARAEditHost PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)

target_compile_definitions(ARAEditHost PRIVATE
    -DARA_ENABLE_VST3=1
    -DARA_ENABLE_CLAP=0
)

target_compile_options(ARAEditHost PRIVATE
    $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>
)

target_link_libraries(ARAEditHost PRIVATE
    ARAExamplesCommon
    ARA_Host_Library
    pluginterfaces   # FUnknown::iid, needed by the spike component handler
    sdk_hosting      # HostApplication (VST3 host context)
    sdk_common
    base
    "-framework ApplicationServices"
    "-framework Cocoa"
)

configure_ARA_Examples_target(ARAEditHost)
