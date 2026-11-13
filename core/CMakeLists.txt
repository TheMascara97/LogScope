cmake_minimum_required(VERSION 3.21)
project(LogScopeCore LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.5 REQUIRED COMPONENTS Core Network SerialPort)
add_executable(LogScopeCore WIN32 main.cpp)
target_link_libraries(LogScopeCore PRIVATE Qt6::Core Qt6::Network Qt6::SerialPort psapi)

# LogScopeCore.exe 用 /MD 链接，进程运行时需要的 C++ 运行库（msvcp140.dll、vcruntime140*.dll）不在
# 产物目录里。开发机装了 Visual Studio 或 VC++ Redistributable，所以本地一直没暴露问题；换一台没有
# 这些的机器，核心会直接起不来，界面只看到"核心未连接"。
#
# 复制到 exe 旁边（而不是走 install 规则）是有原因的：打包配置里 extraResources.from 指的就是
# build/Release 这个目录，只有东西真在这个目录里，npm run package 才会把它带进 resources/core。
# 用 install() 装到别处，打包时看不见，等于没做。Windows 加载 DLL 会先看 exe 所在目录，命中就不再
# 去系统目录，所以放在这里即使目标机器没装运行库也能启动。
#
# 程序走 WIN32（GUI 子系统，不弹控制台）——代价正是缺 DLL 时没有报错对话框，所以这一步不是可选项。
if(WIN32)
  include(InstallRequiredSystemLibraries)
  if(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
    # 这是一个 ALL 目标而不是 add_custom_command(POST_BUILD)：POST_BUILD 只在 exe 真的被重新链接时
    # 才执行，而"exe 没变、dll 不在"恰恰是最常见的状态（第一次加这个规则时就是这样，源码没动，
    # 增量构建是空操作，运行库永远不会出现）。ALL 目标每次构建都跑，copy_if_different 让它实际开销
    # 接近于零。
    add_custom_target(LogScopeCoreRuntime ALL
      COMMAND ${CMAKE_COMMAND} -E copy_if_different ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS} "$<TARGET_FILE_DIR:LogScopeCore>"
      COMMENT "复制 MSVC 运行库到核心产物目录"
      DEPENDS LogScopeCore)
  else()
    # 找不到运行库。这不是配置错误而是发布风险：产物会在别人的机器上缺 DLL 启动失败，所以在这里
    # 明确报出来，好过打出一个看着正常、拷走却起不来的目录。
    message(WARNING "未检测到 MSVC 运行库。请确认 build/Release 里有 msvcp140.dll 与 vcruntime140*.dll，"
                    "否则打包出的 resources/core 在没装 VC++ Redistributable 的机器上无法启动。")
  endif()
endif()