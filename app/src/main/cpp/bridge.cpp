#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
namespace node { int Start(int argc, char* argv[]); }

extern "C" JNIEXPORT jint JNICALL
Java_ai_freedeepseek_pocket_ProxyService_startNode(JNIEnv* env, jobject, jstring script, jstring directory) {
    const char* file = env->GetStringUTFChars(script, nullptr);
    const char* root = env->GetStringUTFChars(directory, nullptr);
    chdir(root);
    setenv("HOME", root, 1);
    setenv("TMPDIR", root, 1);
    size_t bytes = 5 + strlen(file) + 1 + strlen(root) + 1;
    char* storage = static_cast<char*>(malloc(bytes));
    char* argv[3];
    argv[0] = storage; strcpy(argv[0], "node");
    argv[1] = storage + 5; strcpy(argv[1], file);
    argv[2] = argv[1] + strlen(file) + 1; strcpy(argv[2], root);
    env->ReleaseStringUTFChars(script, file);
    env->ReleaseStringUTFChars(directory, root);
    int result = node::Start(3, argv);
    free(storage);
    return result;
}
