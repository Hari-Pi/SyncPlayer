# Sync Messages

Initial protocol families:

```text
room.*
  hello, capabilities, host-change, peer-ready

media.*
  selected, fingerprint, verified, missing, buffer-state

playback.*
  play, pause, seek, rate-change, heartbeat, correction

clock.*
  ping, pong, offset-sample

log.*
  notice, warning, error
```

Every playback message should include:

- message id
- room id
- sender peer id
- media id
- media position
- playback rate
- sender monotonic timestamp

