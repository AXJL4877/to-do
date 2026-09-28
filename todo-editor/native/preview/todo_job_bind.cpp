/* Hold a Job Object with KILL_ON_JOB_CLOSE; assign <pid>; exit on stdin EOF. */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <cstdio>
#include <cstdlib>

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: todo-job-bind.exe <pid>\n");
    return 2;
  }
  const DWORD pid = static_cast<DWORD>(strtoul(argv[1], nullptr, 10));
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return 3;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
    CloseHandle(job);
    return 4;
  }
  HANDLE proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME, FALSE, pid);
  if (!proc) {
    CloseHandle(job);
    return 5;
  }
  if (!AssignProcessToJobObject(job, proc)) {
    CloseHandle(proc);
    CloseHandle(job);
    return 6;
  }
  CloseHandle(proc);
  std::printf("{\"ok\":true,\"ev\":\"job\",\"pid\":%lu}\n", static_cast<unsigned long>(pid));
  std::fflush(stdout);
  /* Block until parent closes our stdin */
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buf[64];
  DWORD rd = 0;
  for (;;) {
    if (!ReadFile(in, buf, sizeof(buf), &rd, nullptr) || rd == 0) break;
  }
  CloseHandle(job); /* KILL_ON_JOB_CLOSE → engine dies */
  return 0;
}
