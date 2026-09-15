/* Direct libavformat/libavutil probe. stdout is one JSON object, stderr diagnostics.
 * Usage: todo-media-probe <local-file> [timeout-ms: 100..30000]
 * Windows uses wmain + _wfopen, never the ANSI code page. Custom AVIO keeps
 * root input local; an empty protocol whitelist denies nested/network URLs.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>
#include <math.h>
#ifdef _WIN32
#include <wchar.h>
#endif
#include <libavformat/avformat.h>
#include <libavutil/time.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>

typedef struct { FILE *file; int64_t deadline; } Input;
static int interrupted(void *opaque) {
    return av_gettime_relative() >= ((Input *)opaque)->deadline;
}
static int read_packet(void *opaque, uint8_t *buf, int size) {
    Input *in = opaque;
    if (interrupted(in)) return AVERROR_EXIT;
    size_t n = fread(buf, 1, (size_t)size, in->file);
    return n ? (int)n : ferror(in->file) ? AVERROR(EIO) : AVERROR_EOF;
}
static int64_t seek_file(void *opaque, int64_t offset, int whence) {
    Input *in = opaque;
    if (interrupted(in)) return AVERROR_EXIT;
#ifdef _WIN32
#define seek64 _fseeki64
#define tell64 _ftelli64
#else
#define seek64 fseeko
#define tell64 ftello
#endif
    if (whence == AVSEEK_SIZE) {
        int64_t current = tell64(in->file);
        if (current < 0 || seek64(in->file, 0, SEEK_END)) return AVERROR(EIO);
        int64_t size = tell64(in->file);
        if (seek64(in->file, current, SEEK_SET)) return AVERROR(EIO);
        return size;
    }
    if (seek64(in->file, offset, whence & ~AVSEEK_FORCE)) return AVERROR(EIO);
    return tell64(in->file);
}
static void json_string(const char *s) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
        if (*p == '"' || *p == '\\') printf("\\%c", *p);
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static int fail(const char *code, int error) {
    char message[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error, message, sizeof(message));
    printf("{\"ok\":false,\"error\":{\"code\":"); json_string(code);
    printf(",\"message\":"); json_string(message); puts("}}");
    return 1;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
    if (argc < 2 || argc > 3) return fail("INVALID_ARGUMENT", AVERROR(EINVAL));
    long timeout = 10000;
    if (argc == 3) {
#ifdef _WIN32
        wchar_t *end; timeout = wcstol(argv[2], &end, 10);
#else
        char *end; timeout = strtol(argv[2], &end, 10);
#endif
        if (*end || timeout < 100 || timeout > 30000) return fail("INVALID_TIMEOUT", AVERROR(EINVAL));
    }
    Input in = {0};
    in.deadline = av_gettime_relative() + timeout * 1000;
#ifdef _WIN32
    in.file = _wfopen(argv[1], L"rb");
#else
    in.file = fopen(argv[1], "rb");
#endif
    if (!in.file) return fail("OPEN_FAILED", AVERROR(errno));
    av_log_set_level(AV_LOG_ERROR);
    unsigned char *buffer = av_malloc(32768);
    AVIOContext *io = buffer ? avio_alloc_context(buffer, 32768, 0, &in, read_packet, NULL, seek_file) : NULL;
    AVFormatContext *format = avformat_alloc_context();
    int result = 0;
    if (!io || !format) {
        if (!io) av_free(buffer);
        result = fail("OUT_OF_MEMORY", AVERROR(ENOMEM)); goto cleanup;
    }
    format->pb = io;
    format->flags |= AVFMT_FLAG_CUSTOM_IO;
    format->interrupt_callback = (AVIOInterruptCB){ interrupted, &in };
    AVDictionary *opts = NULL;
    av_dict_set(&opts, "protocol_whitelist", "", 0);
    av_dict_set(&opts, "probesize", "8388608", 0);
    av_dict_set(&opts, "analyzeduration", "5000000", 0);
    av_dict_set(&opts, "max_streams", "256", 0);
    int ret = avformat_open_input(&format, NULL, NULL, &opts);
    av_dict_free(&opts);
    if (ret >= 0) ret = avformat_find_stream_info(format, NULL);
    if (ret < 0 || interrupted(&in)) {
        result = fail(interrupted(&in) ? "PROBE_TIMEOUT" : "PROBE_FAILED", ret < 0 ? ret : AVERROR_EXIT);
        goto cleanup;
    }
    double duration = format->duration != AV_NOPTS_VALUE ? (double)format->duration / AV_TIME_BASE : 0;
    int video = -1, audio = -1;
    for (unsigned i = 0; i < format->nb_streams; ++i) {
        AVStream *s = format->streams[i];
        if (s->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && !(s->disposition & AV_DISPOSITION_ATTACHED_PIC) && video < 0) video = (int)i;
        if (s->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && audio < 0) audio = (int)i;
        if (s->duration != AV_NOPTS_VALUE) {
            double d = s->duration * av_q2d(s->time_base);
            if (isfinite(d) && d > duration) duration = d;
        }
    }
    if (video < 0 && audio < 0) { result = fail("NO_MEDIA_STREAM", AVERROR_INVALIDDATA); goto cleanup; }
    if (!isfinite(duration) || duration < 0) duration = 0;
    printf("{\"ok\":true,\"engine\":\"libavformat\",\"duration\":%.9f,\"format\":", duration);
    json_string(format->iformat->name);
    printf(",\"hasVideo\":%s,\"hasAudio\":%s", video >= 0 ? "true" : "false", audio >= 0 ? "true" : "false");
    if (video >= 0) {
        AVStream *s = format->streams[video];
        AVRational fps = av_guess_frame_rate(format, s, NULL);
        double rate = av_q2d(fps);
        printf(",\"width\":%d,\"height\":%d,\"frameRate\":%.9f", s->codecpar->width, s->codecpar->height, isfinite(rate) ? rate : 0);
    }
    puts("}");
cleanup:
    avformat_close_input(&format);
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    fclose(in.file);
    return result;
}
