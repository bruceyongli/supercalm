// Tiny macOS durability check. Creates a NEW probe only; never touches an existing file.
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) return 64;
  long mib = argc == 3 ? strtol(argv[2], NULL, 10) : 4;
  if (mib < 1 || mib > 1024) return 64;
  int fd = open(argv[1], O_CREAT | O_EXCL | O_RDWR, 0600);
  if (fd < 0) { perror("create probe"); return 1; }
  char buffer[4096]; memset(buffer, 42, sizeof(buffer));
  for (long i = 0; i < mib * 256; i++) {
    // Unique blocks detect stale/reordered band reads after reconnect.
    memcpy(buffer, &i, sizeof(i));
    if (write(fd, buffer, sizeof(buffer)) != sizeof(buffer)) { perror("write probe"); close(fd); return 1; }
  }
  if (fsync(fd)) { perror("fsync probe"); close(fd); return 1; }
  if (fcntl(fd, F_FULLFSYNC)) { perror("fullsync probe"); close(fd); return 1; }
  close(fd); printf("%ld MiB written, fsync and F_FULLFSYNC passed\n", mib); return 0;
}
