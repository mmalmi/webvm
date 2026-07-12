#include <errno.h>
#include <fcntl.h>
#include <linux/random.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

enum { SEED_BYTES = 64 };

struct seed_buffer {
	int entropy_count;
	int buf_size;
	unsigned char bytes[SEED_BYTES];
};

static void erase_seed(struct seed_buffer *seed) {
	volatile unsigned char *bytes = (volatile unsigned char *)seed;
	for (size_t index = 0; index < sizeof(*seed); index += 1) bytes[index] = 0;
}

int main(void) {
	struct seed_buffer seed = {
		.entropy_count = SEED_BYTES * 8,
		.buf_size = SEED_BYTES,
	};
	size_t offset = 0;
	while (offset < SEED_BYTES) {
		const ssize_t count = read(STDIN_FILENO, seed.bytes + offset, SEED_BYTES - offset);
		if (count > 0) {
			offset += (size_t)count;
			continue;
		}
		if (count < 0 && errno == EINTR) continue;
		fprintf(stderr, "webvm-seed-rng: expected %d bytes of browser entropy\n", SEED_BYTES);
		erase_seed(&seed);
		return 1;
	}

	const int random_fd = open("/dev/random", O_WRONLY | O_CLOEXEC);
	if (random_fd < 0) {
		perror("webvm-seed-rng: open /dev/random");
		erase_seed(&seed);
		return 1;
	}
	const int status = ioctl(random_fd, RNDADDENTROPY, &seed);
	if (status < 0) perror("webvm-seed-rng: RNDADDENTROPY");
	close(random_fd);
	erase_seed(&seed);
	return status < 0 ? 1 : 0;
}
