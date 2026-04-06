/**
 * qoder-injector.c — DYLD_INSERT_LIBRARIES 方案
 * 
 * 在 Go runtime 初始化之前，替换 argv 中的 placeholder 为实际消息。
 * 
 * 编译: cc -shared -o /tmp/qoder-injector.dylib /tmp/qoder-injector.c
 * 使用: QODER_MSG="你好" DYLD_INSERT_LIBRARIES=/tmp/qoder-injector.dylib qodercli -p QODER_INJECT_P --max-turns 1
 */
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <crt_externs.h>

#define PLACEHOLDER "QODER_INJECT_P"

__attribute__((constructor))
static void inject_message(void) {
    const char *msg = getenv("QODER_MSG");
    if (!msg || !msg[0]) return;

    int argc = *_NSGetArgc();
    char **argv = *_NSGetArgv();

    for (int i = 0; i < argc; i++) {
        if (argv[i] && strcmp(argv[i], PLACEHOLDER) == 0) {
            /* strdup 到堆上，替换 argv 指针 */
            argv[i] = strdup(msg);
            /* 清除环境变量，避免泄露 */
            unsetenv("QODER_MSG");
            return;
        }
    }

    /* 也检查子字符串场景（以防 -p 和消息合在一个 argv entry） */
    for (int i = 0; i < argc; i++) {
        if (argv[i] && strstr(argv[i], PLACEHOLDER)) {
            size_t prefix_len = strstr(argv[i], PLACEHOLDER) - argv[i];
            size_t suffix_start = prefix_len + strlen(PLACEHOLDER);
            size_t suffix_len = strlen(argv[i]) - suffix_start;
            size_t msg_len = strlen(msg);
            size_t new_len = prefix_len + msg_len + suffix_len;
            char *new_arg = (char *)malloc(new_len + 1);
            if (new_arg) {
                memcpy(new_arg, argv[i], prefix_len);
                memcpy(new_arg + prefix_len, msg, msg_len);
                memcpy(new_arg + prefix_len + msg_len, argv[i] + suffix_start, suffix_len);
                new_arg[new_len] = '\0';
                argv[i] = new_arg;
                unsetenv("QODER_MSG");
                return;
            }
        }
    }
}
