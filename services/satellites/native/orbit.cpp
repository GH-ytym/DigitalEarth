#include "orbit.h"
#include "vendor/SGP4.h"
#include <cmath>

// SGP4 theory/source: Vallado et al., AIAA 2006-6753; see vendor/NOTICE.
extern "C" DE_API int DE_CALL de_sgp4(const double *e, double start,
    int32_t count, double step, double *out, int32_t capacity, int32_t *written)
{
    if (!written) return 1;
    *written = 0;
    if (!e || !out || !std::isfinite(start) || !std::isfinite(step) ||
        count < 1 || count > 20000 || step < 1 || step > 60) return 1;
    for (int k = 0; k < 10; ++k) if (!std::isfinite(e[k])) return 1;
    if (e[0] < 2433281.5 || e[0] > 2488070 || e[1] <= 0 || e[1] > 20 ||
        e[2] < 0 || e[2] >= 1 || e[3] < 0 || e[3] > 180 ||
        std::abs(start - e[0]) > 7) return 1;
    if (capacity < count) return 2;
    try {
        constexpr double pi = 3.14159265358979323846;
        constexpr double deg = pi / 180;
        constexpr double xpdotp = 1440.0 / (2 * pi);
        elsetrec sat{};
        if (!SGP4Funcs::sgp4init(wgs72, 'i', "00000", e[0] - 2433281.5,
            e[7], e[8]/(xpdotp*1440), e[9]/(xpdotp*1440*1440),
            e[2], e[5]*deg, e[3]*deg, e[6]*deg, e[1]/xpdotp, e[4]*deg, sat) || sat.error) return 3;
        for (int32_t index = 0; index < count; ++index) {
            const double elapsed = index * step;
            double r[3], v[3];
            if (!SGP4Funcs::sgp4(sat, (start-e[0])*1440 + elapsed/60, r, v) || sat.error) return 3;
            // TEME -> PEF using GMST, UT1 approximated by UTC; polar motion = 0.
            // This is a documented approximate Earth-fixed conversion, not ITRF EOP reduction.
            const double theta = SGP4Funcs::gstime_SGP4(start + elapsed/86400);
            out[index*4] = elapsed;
            out[index*4+1] = (std::cos(theta)*r[0] + std::sin(theta)*r[1])*1000;
            out[index*4+2] = (-std::sin(theta)*r[0] + std::cos(theta)*r[1])*1000;
            out[index*4+3] = r[2]*1000;
        }
        *written = count;
        return 0;
    } catch (...) { return 3; }
}
