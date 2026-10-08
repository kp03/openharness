"""Offline checks for both notification cues and mute/microphone preemption."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = (main / 'audio_capture.c').read_text()


def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'


code = r'''
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include "audio_capture.h"
static bool notification_sound_playback_begin(int *slot, uint32_t *bytes) {
    (void)slot; (void)bytes; return false;
}
static bool notification_sound_read(int slot, uint32_t offset, uint8_t *out, size_t count) {
    (void)slot; (void)offset; (void)out; (void)count; return false;
}
static int16_t notification_sound_decode(uint8_t byte) { (void)byte; return 0; }
static void notification_sound_playback_end(void) {}
#define ESP_OK 0
#define ESP_CODEC_DEV_OK 0
#define pdTRUE 1
#define eSetValueWithOverwrite 3
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
typedef struct { int sample_rate,channel,bits_per_sample; } esp_codec_dev_sample_info_t;
static int s_spk=1,s_codec_lock=1,s_beep_task=1,held,opens,closes,writes,notifications,last_cue;
static atomic_bool s_capture_requested;
static bool muted,open_fail,write_fail,mute_on_lock,reenter;
static int stop_after,mute_after;
static int16_t received[10000];
static size_t received_count;
static int64_t clock_us;
bool audio_notify_is_muted(void) { return muted; }
static bool xSemaphoreTake(int lock,int ticks) {
    assert(lock==1&&ticks==0);if(held)return false;held=1;if(mute_on_lock)muted=true;return true;
}
static void xSemaphoreGive(int lock) { assert(lock==1&&held);held=0; }
static int esp_codec_dev_open(int dev,const esp_codec_dev_sample_info_t *fs) {
    assert(dev==1&&held&&fs->sample_rate==AUDIO_SAMPLE_RATE);opens++;return open_fail;
}
static void esp_codec_dev_set_out_vol(int dev,int v) { assert(dev==1&&v==100&&held); }
static void esp_codec_dev_close(int dev) { assert(dev==1&&held);closes++; }
static int esp_codec_dev_write(int dev,void *p,int bytes) {
    assert(dev==1&&held&&bytes>0&&bytes<=AUDIO_SAMPLE_RATE*2/50);writes++;
    if(write_fail)return 1;
    assert(received_count+(size_t)bytes/2<10000);
    memcpy(received+received_count,p,(size_t)bytes);received_count+=(size_t)bytes/2;
    if(stop_after&&writes==stop_after)atomic_store(&s_capture_requested,true);
    if(mute_after&&writes==mute_after)muted=true;
    return 0;
}
static void xTaskNotify(int task,unsigned cue,int mode) {
    assert(task==1&&mode==eSetValueWithOverwrite);notifications++;last_cue=cue;
}
static int64_t esp_timer_get_time(void) {
    int64_t sampled=clock_us;
    if(reenter){reenter=false;clock_us+=1000;audio_notify_done();}
    return sampled;
}
'''
start = source.index('typedef struct { uint16_t hz, ms, gap_ms; } note_t;')
end = source.index('static int16_t s_tone[TONE_BLOCK_SAMPLES];') + len('static int16_t s_tone[TONE_BLOCK_SAMPLES];')
code += source[start:end] + '\n'
for name in ['cue_samples', 'render_tone', 'play_beep', 'queue_cue', 'audio_notify_test']:
    code += function(name)
code += r'''
void audio_notify_start(void) { queue_cue(CUE_START); }
void audio_notify_done(void) { queue_cue(CUE_DONE); }
static void reset(void) {
    muted=open_fail=write_fail=mute_on_lock=false;atomic_store(&s_capture_requested,false);
    held=opens=closes=writes=stop_after=mute_after=0;received_count=0;
}
static bool audible(size_t first,size_t last) {
    for(size_t i=first;i<last;i++)if(received[i])return true;
    return false;
}
int main(void) {
    assert(sizeof s_tone == 640);
    reset();play_beep(CUE_START);
    assert(!held&&opens==1&&closes==1&&received_count==2880);
    assert(audible(80,1040)&&!audible(1040,1520)&&audible(1600,2720));
    reset();play_beep(CUE_DONE);
    assert(!held&&opens==1&&closes==1&&received_count==5600);
    assert(audible(80,1200)&&!audible(1200,1920)&&audible(2000,3120));
    reset();muted=true;play_beep(CUE_START);assert(!opens&&!writes);
    reset();atomic_store(&s_capture_requested,true);play_beep(CUE_DONE);assert(!opens&&!writes);
    reset();mute_on_lock=true;play_beep(CUE_START);assert(!held&&!opens&&!writes);
    reset();held=1;play_beep(CUE_DONE);assert(!opens&&!writes);held=0;
    for(int n=1;n<6;n++) {
        reset();stop_after=n;play_beep(CUE_DONE);assert(writes==n&&!held&&closes==1);
        reset();mute_after=n;play_beep(CUE_START);assert(writes==n&&!held&&closes==1);
    }
    reset();open_fail=true;play_beep(CUE_DONE);assert(!held&&opens==1&&!closes&&!writes);
    reset();write_fail=true;play_beep(CUE_START);assert(!held&&opens==1&&closes==1&&writes==1);
    clock_us=1000000;audio_notify_start();assert(notifications==1&&last_cue==CUE_START);
    clock_us=1200000;audio_notify_start();assert(notifications==1);
    clock_us=1500000;audio_notify_start();assert(notifications==2);
    clock_us=1550000;audio_notify_done();assert(notifications==3&&last_cue==CUE_DONE);
    clock_us=2000000;audio_notify_done();assert(notifications==3);
    clock_us=2550000;audio_notify_done();assert(notifications==4);
    clock_us=4000000;reenter=true;audio_notify_done();assert(notifications==5);
    clock_us=(int64_t)(UINT32_MAX-500u)*1000;audio_notify_done();assert(notifications==6);
    clock_us=((INT64_C(1)<<32)+498)*1000;audio_notify_done();assert(notifications==6);
    clock_us+=2000;audio_notify_done();assert(notifications==7);
    muted=true;clock_us+=1000000;audio_notify_done();assert(notifications==7);
    // The app's test button: no debounce, but still muted, mic-preempted and speakerless.
    assert(!audio_notify_test()&&notifications==7);
    muted=false;assert(audio_notify_test()&&notifications==8&&last_cue==CUE_DONE);
    assert(audio_notify_test()&&notifications==9);
    atomic_store(&s_capture_requested,true);assert(!audio_notify_test()&&notifications==9);
    atomic_store(&s_capture_requested,false);s_beep_task=0;assert(!audio_notify_test());s_beep_task=1;
    puts("Notification: start/done samples, gaps, 640B buffer, mute/mic/error release, debounce, wrap and test cue PASS (offline)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-notify-') as folder:
    out = Path(folder)
    (out / 'notify.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(out / 'notify.c'), '-o', str(out / 'notify')], check=True)
    subprocess.run([str(out / 'notify')], check=True)
