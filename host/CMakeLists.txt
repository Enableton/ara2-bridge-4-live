cmake_minimum_required(VERSION 3.19)
project(BridgeHostLibs LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_library(bridge_core STATIC
    common/Wav.cpp
    realign/Realign.cpp
    jobio/Job.mm
    audio/AudioDecode.mm
    audio/OutputDevices.mm
    plugins/PlugInFinder.cpp
    hostcore/JobLayout.cpp
    hostcore/ApplyJob.cpp
    hostcore/RunGuard.cpp
    hostcore/Options.cpp
    hostcore/RenderRepair.cpp
    hostcore/KeepRaw.cpp
    hostcore/TransportKey.cpp
    hostcore/Commands.cpp
    hostcore/AudioOutput.cpp
)
target_include_directories(bridge_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(bridge_core PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bridge_core PUBLIC "-framework Foundation" "-framework AudioToolbox" "-framework CoreAudio" "-framework CoreFoundation")

add_executable(bridge_tests
    tests/test_main.cpp
    tests/test_wav.cpp
    tests/test_realign.cpp
    tests/test_job.cpp
    tests/test_decode.cpp
    tests/test_finder.cpp
    tests/test_layout.cpp
    tests/test_apply.cpp
    tests/test_runguard.cpp
    tests/test_repair.cpp
    tests/test_transportkey.cpp
    tests/test_text.mm
    tests/test_commands.cpp
    tests/test_audiooutput.cpp
    tests/test_keepraw.mm
)
target_link_libraries(bridge_tests PRIVATE bridge_core)
target_compile_options(bridge_tests PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_compile_definitions(bridge_tests PRIVATE BRIDGE_TEST_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests")

enable_testing()
add_test(NAME bridge_tests COMMAND bridge_tests)

add_executable(wavdiff tools/wavdiff.cpp)
target_link_libraries(wavdiff PRIVATE bridge_core)

add_executable(realign_tool tools/realign_tool.cpp)
target_link_libraries(realign_tool PRIVATE bridge_core)
