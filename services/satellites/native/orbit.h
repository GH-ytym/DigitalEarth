#pragma once
#include <stdint.h>
#ifdef _WIN32
#define DE_API __declspec(dllexport)
#define DE_CALL __cdecl
#else
#define DE_API
#define DE_CALL
#endif
#ifdef __cplusplus
extern "C" {
#endif
/* elements[10]: epoch JD UTC, mean motion rev/day, eccentricity, inclination deg,
   RAAN deg, argument of pericenter deg, mean anomaly deg, BSTAR, ndot, nddot.
   Caller owns output; each row is [dt_s,x_m,y_m,z_m]. capacity/written count rows.
   0=success, 1=invalid input, 2=capacity, 3=SGP4 initialization/propagation failure. */
DE_API int DE_CALL de_sgp4(const double *elements, double start_jd_utc,
    int32_t count, double step_s, double *output, int32_t capacity, int32_t *written);
#ifdef __cplusplus
}
#endif
